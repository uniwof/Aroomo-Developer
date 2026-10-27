#!/usr/bin/env bash
# 备份（在 backup sidecar 容器内运行）→ restic 仓库（AWS 之外的 S3 兼容存储，或本机文件夹）。
# PRODUCT §7.1、§7.6、§10.2 O1；DECISIONS v4.3 第 4 条 / P0-e。
#
# 一次备份 = 一个 restic 快照，内容：
#   /backup-stage/globals.sql            角色（不含密码哈希，--no-role-passwords）
#   /backup-stage/db/<库名>.dump         每个业务库一个 pg_dump 自定义格式文件（lobechat、litellm、aroomo_core…）
#   /backup-stage/db/<库名>.counts.tsv   与 dump 同一事务快照下的「表 → 行数」，恢复后逐表核对
#   /backup-stage/manifest.json          元数据
#   /data/rustfs                         对象存储数据卷（只读挂载）
#   /data/config                         非密钥配置（LiteLLM config.yaml 等）
# 不备份：deploy/.env，尤其 LITELLM_SALT_KEY（由用户离线另存，见 docs/ops/BACKUP.md）。
#
# 环境变量（compose 注入）：
#   必填  RESTIC_REPOSITORY RESTIC_PASSWORD PGHOST PGUSER PGPASSWORD
#   S3    AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
#   可选  BACKUP_HOST_TAG（默认 aroomo）BACKUP_DATABASES（空格分隔；默认自动发现除 postgres 外的全部库）
#         RETENTION_KEEP_LAST(0) RETENTION_KEEP_DAILY(7) RETENTION_KEEP_WEEKLY(4) RETENTION_KEEP_MONTHLY(6)
#         BACKUP_CHECK=weekly|always|never（默认 weekly）BACKUP_CHECK_WEEKDAY（1–7，默认 7=周日）
#         BACKUP_CHECK_SUBSET（默认 5%）BACKUP_FILE_PATHS（默认 "/data/rustfs /data/config"）
#
# 输出：过程日志写 stderr；最后一行 JSON 结果写 stdout。失败时非零退出，并输出一行中文原因。
set -Eeuo pipefail

STAGE="${AROOMO_STAGE_DIR:-/backup-stage}"  # 仅测试时覆盖；恢复脚本用同一路径
HOST_TAG="${BACKUP_HOST_TAG:-aroomo}"
TAG=aroomo

step="启动"
started_epoch=$(date +%s)
started_at=$(date '+%Y-%m-%dT%H:%M:%S%z')

log() { printf 'backup: %s\n' "$*" >&2; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

on_error() {
  local code=$?
  local dur=$(( $(date +%s) - started_epoch ))
  printf 'backup: 失败——%s（退出码 %s）\n' "$step" "$code" >&2
  printf '{"event":"backup","status":"failed","step":"%s","started_at":"%s","duration_s":%s,"exit_code":%s}\n' \
    "$(json_escape "$step")" "$started_at" "$dur" "$code"
  exit "$code"
}
trap on_error ERR

fail() { step="$1"; false; }

# ---------------------------------------------------------------------------
step="检查环境变量"
[[ -r "$(dirname "${BASH_SOURCE[0]}")/lib/table-counts.sql" ]] || fail "缺少 scripts/lib/table-counts.sql"
[[ -n "${RESTIC_REPOSITORY:-}" ]] || fail "RESTIC_REPOSITORY 未设置（备份仓库地址）"
[[ -n "${RESTIC_PASSWORD:-}" ]] || fail "RESTIC_PASSWORD 未设置（备份加密口令）"
[[ -n "${PGHOST:-}" && -n "${PGUSER:-}" ]] || fail "PGHOST / PGUSER 未设置"
# LITELLM_SALT_KEY 绝不进入备份：备份容器根本不应该拿到它
[[ -z "${LITELLM_SALT_KEY:-}" ]] || fail "备份容器里出现了 LITELLM_SALT_KEY，拒绝备份（它必须离线另存，不能进入备份）"
for v in RETENTION_KEEP_LAST RETENTION_KEEP_DAILY RETENTION_KEEP_WEEKLY RETENTION_KEEP_MONTHLY; do
  val="${!v:-0}"
  [[ "$val" =~ ^[0-9]+$ ]] || fail "$v 必须是非负整数（当前：$val）"
done

step="连接 PostgreSQL"
psql -X -q -At -d postgres -c 'select 1' >/dev/null

step="打开 restic 仓库"
rc=0
restic cat config >/dev/null 2>&1 || rc=$?
case "$rc" in
  0) ;;
  10)
    log "仓库还不存在，初始化"
    step="初始化 restic 仓库（检查仓库地址和访问密钥）"
    restic init >&2
    ;;
  12) fail "备份口令 RESTIC_PASSWORD 不对，打不开仓库" ;;
  *) fail "连不上备份仓库（检查 RESTIC_REPOSITORY、访问密钥和网络）" ;;
esac

# ---------------------------------------------------------------------------
step="准备暂存目录"
rm -rf "$STAGE"
mkdir -p "$STAGE/db"
chmod 700 "$STAGE"

if [[ -n "${BACKUP_DATABASES:-}" ]]; then
  read -r -a dbs <<<"$BACKUP_DATABASES"
else
  step="列出数据库"
  mapfile -t dbs < <(psql -X -q -At -d postgres -c \
    "select datname from pg_database where not datistemplate and datallowconn and datname <> 'postgres' order by 1")
fi
(( ${#dbs[@]} > 0 )) || fail "没有找到要备份的数据库"

step="导出角色（不含密码）"
pg_dumpall --globals-only --no-role-passwords >"$STAGE/globals.sql"

COUNT_SQL="$(<"$(dirname "${BASH_SOURCE[0]}")/lib/table-counts.sql")"

# 在同一个 REPEATABLE READ 事务快照里：导出快照 → pg_dump --snapshot → 统计行数。
# 这样即使服务在运行，dump 与行数也完全一致，恢复后可以逐表精确核对。
dump_db() {
  local db="$1" snap line
  coproc PSQL { psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -d "$db" 2>&1; }
  # shellcheck disable=SC2154  # PSQL 数组由 coproc 定义
  printf '%s\n' "begin isolation level repeatable read read only;" "select pg_export_snapshot();" >&"${PSQL[1]}"
  IFS= read -r -t 30 snap <&"${PSQL[0]}" || return 1
  [[ "$snap" =~ ^[0-9A-F-]+$ ]] || { log "无法导出事务快照：$snap"; return 1; }

  pg_dump -Fc --no-password --snapshot="$snap" -d "$db" -f "$STAGE/db/$db.dump"

  printf '%s\n' "$COUNT_SQL" "select '__AROOMO_END__';" >&"${PSQL[1]}"
  : >"$STAGE/db/$db.counts.tsv"
  while IFS= read -r -t 600 line <&"${PSQL[0]}"; do
    [[ "$line" == "__AROOMO_END__" ]] && break
    if [[ "$line" != *$'\t'* ]]; then log "统计行数出错：$line"; return 1; fi
    printf '%s\n' "$line" >>"$STAGE/db/$db.counts.tsv"
  done
  [[ "$line" == "__AROOMO_END__" ]] || return 1
  printf '%s\n' "commit;" '\q' >&"${PSQL[1]}"
  wait "$PSQL_PID" 2>/dev/null || true
}

for db in "${dbs[@]}"; do
  step="导出数据库 $db"
  log "导出 $db"
  dump_db "$db"
done

step="写入清单"
{
  printf '{"format":1,"created_at":"%s","host_tag":"%s","databases":[' "$started_at" "$HOST_TAG"
  first=1
  for db in "${dbs[@]}"; do
    (( first )) || printf ','
    first=0
    printf '{"name":"%s","tables":%s}' "$db" "$(wc -l <"$STAGE/db/$db.counts.tsv" | tr -d ' ')"
  done
  printf '],"pg_dump":"%s","excluded":["deploy/.env","LITELLM_SALT_KEY"]}\n' "$(pg_dump --version | sed 's/"//g')"
} >"$STAGE/manifest.json"

# ---------------------------------------------------------------------------
read -r -a file_paths <<<"${BACKUP_FILE_PATHS:-/data/rustfs /data/config}"
paths=("$STAGE")
for p in "${file_paths[@]}"; do
  if [[ -e "$p" ]]; then paths+=("$p"); else log "跳过不存在的路径 $p"; fi
done

step="上传快照到 restic 仓库（检查网络和存储空间）"
log "上传：${paths[*]}"
summary=$(restic backup --json --host "$HOST_TAG" --tag "$TAG" \
  --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' \
  "${paths[@]}" | jq -c 'select(.message_type == "summary")')
snapshot_id=$(jq -r '.snapshot_id // empty' <<<"$summary")
[[ -n "$snapshot_id" ]] || fail "restic 没有返回快照 id"
size_bytes=$(jq -r '.total_bytes_processed // 0' <<<"$summary")
added_bytes=$(jq -r '.data_added // 0' <<<"$summary")
rm -rf "$STAGE"

# ---------------------------------------------------------------------------
step="按保留策略清理旧快照"
keep=()
(( ${RETENTION_KEEP_LAST:-0} > 0 )) && keep+=(--keep-last "$RETENTION_KEEP_LAST")
(( ${RETENTION_KEEP_DAILY:-7} > 0 )) && keep+=(--keep-daily "${RETENTION_KEEP_DAILY:-7}")
(( ${RETENTION_KEEP_WEEKLY:-4} > 0 )) && keep+=(--keep-weekly "${RETENTION_KEEP_WEEKLY:-4}")
(( ${RETENTION_KEEP_MONTHLY:-6} > 0 )) && keep+=(--keep-monthly "${RETENTION_KEEP_MONTHLY:-6}")
(( ${#keep[@]} > 0 )) || fail "保留策略至少要有一项大于 0（RETENTION_KEEP_*）"
log "保留策略：${keep[*]}"
restic forget --host "$HOST_TAG" --tag "$TAG" "${keep[@]}" --prune >&2

checked=false
case "${BACKUP_CHECK:-weekly}" in
  always) do_check=1 ;;
  never) do_check=0 ;;
  weekly) [[ "$(date +%u)" == "${BACKUP_CHECK_WEEKDAY:-7}" ]] && do_check=1 || do_check=0 ;;
  *) fail "BACKUP_CHECK 只能是 weekly / always / never" ;;
esac
if (( do_check )); then
  step="完整性检查（restic check --read-data-subset=${BACKUP_CHECK_SUBSET:-5%}）"
  restic check --read-data-subset="${BACKUP_CHECK_SUBSET:-5%}" >&2
  checked=true
fi

dur=$(( $(date +%s) - started_epoch ))
log "完成，快照 ${snapshot_id:0:8}，用时 ${dur} 秒"
printf '{"event":"backup","status":"ok","started_at":"%s","duration_s":%s,"snapshot_id":"%s","size_bytes":%s,"added_bytes":%s,"databases":%s,"checked":%s}\n' \
  "$started_at" "$dur" "$snapshot_id" "$size_bytes" "$added_bytes" "${#dbs[@]}" "$checked"
