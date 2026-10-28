#!/usr/bin/env bash
# 备份（在 backup sidecar 容器内运行）→ 用主密钥的公钥加密 → 异地 S3 存储（AWS 之外）和 / 或本机文件夹。
# PRODUCT §7.1、§7.6、§10.2 O1；DECISIONS D49、D64（实现注 a）、D65。
#
# 一次备份 = 一个文件 aroomo-<主机标签>-<UTC 时间>.tar.zst.age（+ 同名 .meta.json），压缩包内容：
#   backup-stage/globals.sql            角色（不含密码哈希，--no-role-passwords）
#   backup-stage/db/<库名>.dump         每个业务库一个 pg_dump 自定义格式文件（lobechat、litellm、aroomo_core…）
#   backup-stage/db/<库名>.counts.tsv   与 dump 同一事务快照下的「表 → 行数」，恢复后逐表核对
#   backup-stage/manifest.json          元数据
#   data/rustfs                         对象存储数据卷（只读挂载）
#   data/config                         非密钥配置（LiteLLM config.yaml 等）
#   data/secrets/aroomo.env             .env（含 LITELLM_SALT_KEY；BACKUP_INCLUDE_ENV=1 时，默认开）
# 整个压缩包用 age 加密给 BACKUP_AGE_RECIPIENT（主密钥的公钥，age1… 开头）。这台机器上没有私钥，
# 所以这里只能加密、不能解密；私钥（主密钥）只由用户离线保管，恢复时才提供（D64）。
#
# 环境变量（compose 注入）：
#   必填  BACKUP_AGE_RECIPIENT PGHOST PGUSER PGPASSWORD；BACKUP_S3_* 和 BACKUP_LOCAL_DIR 至少设一个
#   异地  BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_PREFIX（默认 server；电脑版 pc/<电脑名>）
#         BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_REGION（默认 auto）BACKUP_S3_PROVIDER（默认 Other）
#   本机  BACKUP_LOCAL_DIR（容器内路径；设置后本机也存一份）BACKUP_LOCAL_KEEP（默认 3，D65）
#   可选  BACKUP_HOST_TAG（默认 aroomo）BACKUP_DATABASES（空格分隔；默认自动发现除 postgres 外的全部库）
#         RETENTION_KEEP_LAST(0) RETENTION_KEEP_DAILY(7) RETENTION_KEEP_WEEKLY(4) RETENTION_KEEP_MONTHLY(6)（异地）
#         BACKUP_CHECK=weekly|always|never（默认 weekly）BACKUP_CHECK_WEEKDAY（1–7，默认 7=周日）
#         BACKUP_FILE_PATHS（默认 "/data/rustfs /data/config"）BACKUP_INCLUDE_ENV（默认 1）
#         BACKUP_ENV_FILE（默认 /data/secrets/aroomo.env）BACKUP_SPOOL_DIR（默认 /tmp/aroomo-spool）
#
# 输出：过程日志写 stderr；最后一行 JSON 结果写 stdout。失败时非零退出，并输出一行中文原因。
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/backup-common.sh
. "$here/lib/backup-common.sh"

STAGE="${AROOMO_STAGE_DIR:-/backup-stage}"  # 仅测试时覆盖；恢复脚本用同一路径
HOST_TAG="${BACKUP_HOST_TAG:-aroomo}"
SPOOL="${BACKUP_SPOOL_DIR:-/tmp/aroomo-spool}"
ENV_FILE="${BACKUP_ENV_FILE:-/data/secrets/aroomo.env}"

step="启动"
started_epoch=$(date +%s)
started_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
partial=""

log() { printf 'backup: %s\n' "$*" >&2; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cleanup() { [[ -n "$partial" && -f "$partial" ]] && rm -f "$partial"; rm -rf "$STAGE"; return 0; }
trap cleanup EXIT

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
[[ -r "$here/lib/table-counts.sql" ]] || fail "缺少 scripts/lib/table-counts.sql"
[[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] \
  || fail "BACKUP_AGE_RECIPIENT 未设置（主密钥的公钥，age1 开头）。在用户电脑上生成主密钥后，把窗口里显示的公钥填进 .env"
[[ "$BACKUP_AGE_RECIPIENT" =~ $AROOMO_AGE_RECIPIENT_RE ]] || fail "BACKUP_AGE_RECIPIENT 格式不对（应为 age1 开头的 62 个字符）"
# 主密钥（私钥）绝不能出现在做备份的机器上（D64）
[[ -z "${AROOMO_BACKUP_IDENTITY:-}" && -z "${AROOMO_BACKUP_IDENTITY_FILE:-}" ]] \
  || fail "备份环境里出现了主密钥（AROOMO_BACKUP_IDENTITY），拒绝备份。主密钥只在恢复时临时提供，不能放在服务器或电脑的配置里"
if [[ -r "$ENV_FILE" ]] && grep -qE 'AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}' "$ENV_FILE"; then
  fail ".env 里出现了主密钥（AGE-SECRET-KEY-1…），拒绝备份。请从 .env 删除它，只保留公钥 BACKUP_AGE_RECIPIENT"
fi
offsite_configured || [[ -n "${BACKUP_LOCAL_DIR:-}" ]] \
  || fail "没有备份目标：BACKUP_S3_ENDPOINT/BACKUP_S3_BUCKET（异地）和 BACKUP_LOCAL_DIR（本机）至少设一个"
for v in RETENTION_KEEP_LAST RETENTION_KEEP_DAILY RETENTION_KEEP_WEEKLY RETENTION_KEEP_MONTHLY BACKUP_LOCAL_KEEP; do
  val="${!v:-0}"
  [[ "$val" =~ ^[0-9]+$ ]] || fail "$v 必须是非负整数（当前：$val）"
done
local_keep="${BACKUP_LOCAL_KEEP:-3}"
(( local_keep >= 1 )) || fail "BACKUP_LOCAL_KEEP 至少为 1"
case "${BACKUP_CHECK:-weekly}" in always|never|weekly) ;; *) fail "BACKUP_CHECK 只能是 weekly / always / never" ;; esac

if offsite_configured; then
  offsite_setup
  step="连接异地存储（检查 BACKUP_S3_ENDPOINT、桶名、访问密钥和网络）"
  rclone lsf --max-depth 1 "$(offsite_dir)" >/dev/null
fi
if [[ -n "${BACKUP_LOCAL_DIR:-}" ]]; then
  step="检查本机备份文件夹 $BACKUP_LOCAL_DIR"
  mkdir -p "$BACKUP_LOCAL_DIR"
  [[ -w "$BACKUP_LOCAL_DIR" ]] || fail "本机备份文件夹不可写：$BACKUP_LOCAL_DIR"
fi

step="连接 PostgreSQL"
psql -X -q -At -d postgres -c 'select 1' >/dev/null

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

COUNT_SQL="$(<"$here/lib/table-counts.sql")"

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

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="$(backup_basename "$HOST_TAG" "$stamp")"

step="写入清单"
{
  printf '{"format":%s,"created_at":"%s","host_tag":"%s","databases":[' "$AROOMO_BACKUP_FORMAT" "$started_at" "$HOST_TAG"
  first=1
  for db in "${dbs[@]}"; do
    (( first )) || printf ','
    first=0
    printf '{"name":"%s","tables":%s}' "$db" "$(wc -l <"$STAGE/db/$db.counts.tsv" | tr -d ' ')"
  done
  printf '],"pg_dump":"%s"}\n' "$(pg_dump --version | sed 's/"//g')"
} >"$STAGE/manifest.json"

# ---------------------------------------------------------------------------
read -r -a file_paths <<<"${BACKUP_FILE_PATHS:-/data/rustfs /data/config}"
rel=("${STAGE#/}")
for p in "${file_paths[@]}"; do
  if [[ -e "$p" ]]; then rel+=("${p#/}"); else log "跳过不存在的路径 $p"; fi
done
env_included=false
if [[ "${BACKUP_INCLUDE_ENV:-1}" == "1" ]]; then
  if [[ -f "$ENV_FILE" && -r "$ENV_FILE" ]]; then
    rel+=("${ENV_FILE#/}")
    env_included=true
  else
    log "没有找到 .env（$ENV_FILE），这次备份不含 .env；恢复时需要另有 LITELLM_SALT_KEY"
  fi
fi

if [[ -n "${BACKUP_LOCAL_DIR:-}" ]]; then outdir="$BACKUP_LOCAL_DIR"; else outdir="$SPOOL"; mkdir -p "$outdir"; fi
out="$outdir/$name.tar.zst.age"
partial="$out.partial"

step="打包并用主密钥的公钥加密"
log "打包：${rel[*]}"
# 对象存储在运行中，GNU tar 遇到「读的时候文件变了」退出 1，属正常；>1 才算失败
{
  rc=0
  tar -C / --warning=no-file-changed --warning=no-file-removed --ignore-failed-read -cf - "${rel[@]}" || rc=$?
  if (( rc > 1 )); then exit "$rc"; fi
} | zstd -q -T0 -3 | age -r "$BACKUP_AGE_RECIPIENT" -o "$partial"
head -c 22 "$partial" | grep -q '^age-encryption.org/v1' || fail "加密结果不是 age 格式"
mv -f "$partial" "$out"
partial=""
size_bytes=$(stat -c %s "$out")
sha=$(sha256sum "$out" | cut -d' ' -f1)
cat >"$outdir/$name.meta.json" <<EOF
{"format":$AROOMO_BACKUP_FORMAT,"file":"$name.tar.zst.age","created_at":"$started_at","stamp_utc":"$stamp","host_tag":"$HOST_TAG","encryption":"age-x25519","cipher":"X25519 + ChaCha20-Poly1305 (age v1)","kdf":"none (public-key)","recipient":"$BACKUP_AGE_RECIPIENT","compression":"zstd","sha256":"$sha","size_bytes":$size_bytes,"env_included":$env_included,"databases":${#dbs[@]}}
EOF

uploaded=false
if offsite_configured; then
  step="上传到异地存储（检查网络和存储空间）"
  dest="$(offsite_dir)"
  rclone copyto "$out" "$dest/$name.tar.zst.age"
  rclone copyto "$outdir/$name.meta.json" "$dest/$name.meta.json"
  step="核对异地文件大小"
  remote_size=$(rclone lsjson "$dest/$name.tar.zst.age" | jq -r '.[0].Size // -1')
  [[ "$remote_size" == "$size_bytes" ]] || fail "异地文件大小不对（本地 $size_bytes，异地 $remote_size）"
  uploaded=true
fi

# ---------------------------------------------------------------------------
delete_pair() { # delete_pair <where> <文件名>
  local base="${2%.tar.zst.age}"
  if [[ "$1" == local ]]; then
    rm -f "$BACKUP_LOCAL_DIR/$base.tar.zst.age" "$BACKUP_LOCAL_DIR/$base.meta.json"
  else
    rclone deletefile "$(offsite_dir)/$base.tar.zst.age"
    rclone deletefile "$(offsite_dir)/$base.meta.json" 2>/dev/null || true
  fi
}

local_kept=0
if [[ -n "${BACKUP_LOCAL_DIR:-}" ]]; then
  step="本机只保留最近 $local_keep 份"
  mapfile -t all < <(list_backups local)
  mapfile -t keep < <(printf '%s\n' "${all[@]}" | retention_keep "$local_keep" 0 0 0)
  for f in "${all[@]}"; do
    [[ " ${keep[*]} " == *" $f "* ]] || { log "删除本机旧备份 $f"; delete_pair local "$f"; }
  done
  local_kept=${#keep[@]}
else
  rm -f "$out" "$outdir/$name.meta.json"
fi

offsite_count=0
if offsite_configured; then
  step="按保留策略清理异地旧备份"
  last=${RETENTION_KEEP_LAST:-0} daily=${RETENTION_KEEP_DAILY:-7} weekly=${RETENTION_KEEP_WEEKLY:-4} monthly=${RETENTION_KEEP_MONTHLY:-6}
  (( last + daily + weekly + monthly > 0 )) || fail "保留策略至少要有一项大于 0（RETENTION_KEEP_*）"
  mapfile -t all < <(list_backups offsite)
  mapfile -t keep < <(printf '%s\n' "${all[@]}" | retention_keep "$last" "$daily" "$weekly" "$monthly")
  log "保留策略：last=$last daily=$daily weekly=$weekly monthly=$monthly；共 ${#all[@]} 份，保留 ${#keep[@]} 份"
  for f in "${all[@]}"; do
    [[ " ${keep[*]} " == *" $f "* ]] || { log "删除异地旧备份 $f"; delete_pair offsite "$f"; }
  done
  offsite_count=${#keep[@]}
fi

checked=false
case "${BACKUP_CHECK:-weekly}" in
  always) do_check=1 ;;
  never) do_check=0 ;;
  weekly) [[ "$(date +%u)" == "${BACKUP_CHECK_WEEKDAY:-7}" ]] && do_check=1 || do_check=0 ;;
esac
if (( do_check )) && offsite_configured; then
  # 这台机器没有主密钥，解不开；能做的是确认存储里的字节完好。能否解开由恢复演练验证。
  step="完整性检查（重新下载，核对 SHA-256 和 age 文件头）"
  got=$(rclone cat "$(offsite_dir)/$name.tar.zst.age" | sha256sum | cut -d' ' -f1)
  [[ "$got" == "$sha" ]] || fail "异地备份的 SHA-256 不一致（存储里的文件损坏了）"
  rclone cat --count 22 "$(offsite_dir)/$name.tar.zst.age" | grep -q '^age-encryption.org/v1' || fail "异地备份的文件头不对"
  checked=true
fi

dur=$(( $(date +%s) - started_epoch ))
log "完成：$name（${size_bytes} 字节），用时 ${dur} 秒"
if [[ "$uploaded" == false ]]; then log "注意：还没有配置异地存储，这份备份只在本机。硬盘坏了会一起丢。"; fi
printf '{"event":"backup","status":"ok","started_at":"%s","duration_s":%s,"snapshot_id":"%s","sha256":"%s","size_bytes":%s,"databases":%s,"env_included":%s,"offsite":%s,"offsite_count":%s,"local_count":%s,"checked":%s}\n' \
  "$started_at" "$dur" "$name" "$sha" "$size_bytes" "${#dbs[@]}" "$env_included" "$uploaded" "$offsite_count" "$local_kept" "$checked"
