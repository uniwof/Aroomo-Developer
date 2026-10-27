#!/usr/bin/env bash
# 恢复（在 restore 容器内运行；与 backup 同一镜像，但对象存储卷可写）。
# ⚠ 会删除并重建数据库、清空对象存储卷，不可逆。必须带 --yes-overwrite-database 才执行
# （DECISIONS v4.3：不可逆操作二次确认）。
#
#   docker compose --profile restore run --rm restore --list
#   docker compose stop lobe litellm core rustfs          # 先停服务（脚本会检查）
#   docker compose --profile restore run --rm restore --yes-overwrite-database [快照id|latest]
#   docker compose up -d
#
# 选项：--no-files     只恢复数据库，不动对象存储
#       --skip-verify  不做行数核对（不推荐）
# 环境变量：RESTIC_REPOSITORY RESTIC_PASSWORD AWS_* PGHOST PGUSER PGPASSWORD
#           BACKUP_HOST_TAG（默认 aroomo）RESTORE_ROOT（默认 /restore-root；对象存储卷挂在 $RESTORE_ROOT/data/rustfs）
#           RESTORE_FILES_PATH（默认 /data/rustfs）RESTORE_RUSTFS_URL（默认 http://rustfs:9000/health，用来确认 rustfs 已停止）
#
# 输出：过程日志写 stderr；最后一行 JSON（含各阶段耗时）写 stdout。失败时非零退出并输出一行中文原因。
set -Eeuo pipefail

STAGE="${AROOMO_STAGE_DIR:-/backup-stage}"
HOST_TAG="${BACKUP_HOST_TAG:-aroomo}"
RESTORE_ROOT="${RESTORE_ROOT:-/restore-root}"
RUSTFS_URL="${RESTORE_RUSTFS_URL:-http://rustfs:9000/health}"
FILES_PATH="${RESTORE_FILES_PATH:-/data/rustfs}"   # 快照里对象存储的路径
files_dir="${RESTORE_ROOT%/}$FILES_PATH"
STOP_HINT="docker compose stop lobe litellm core rustfs"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step="启动"
started_epoch=$(date +%s)
started_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
work=""
phases=""

log() { printf 'restore: %s\n' "$*" >&2; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cleanup() { [[ -n "$work" && -d "$work" ]] && rm -rf "$work"; return 0; }
trap cleanup EXIT

on_error() {
  local code=$?
  printf 'restore: 失败——%s（退出码 %s）\n' "$step" "$code" >&2
  printf '{"event":"restore","status":"failed","step":"%s","started_at":"%s","duration_s":%s,"exit_code":%s}\n' \
    "$(json_escape "$step")" "$started_at" "$(( $(date +%s) - started_epoch ))" "$code"
  exit "$code"
}
trap on_error ERR
fail() { step="$1"; false; }

phase_start=0
phase_begin() { step="$1"; phase_start=$(date +%s); log "▶ $1"; }
phase_end() {
  local d=$(( $(date +%s) - phase_start ))
  phases+="${phases:+,}\"$1\":$d"
  log "  用时 ${d} 秒"
}

restic_filter=(--host "$HOST_TAG" --tag aroomo)

# ---------------------------------------------------------------------------
case "${1:-}" in
  --list)
    : "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY 未设置}"
    exec restic snapshots "${restic_filter[@]}"
    ;;
  --yes-overwrite-database) shift ;;
  *)
    echo "restore: 这会删除并重建数据库、清空对象存储。确认请加参数 --yes-overwrite-database [快照id]" >&2
    exit 64
    ;;
esac

snapshot="latest"
do_files=1
do_verify=1
for arg in "$@"; do
  case "$arg" in
    --no-files) do_files=0 ;;
    --skip-verify) do_verify=0 ;;
    -*) echo "restore: 未知参数 $arg" >&2; exit 64 ;;
    *) snapshot="$arg" ;;
  esac
done

step="检查环境变量"
[[ -n "${RESTIC_REPOSITORY:-}" ]] || fail "RESTIC_REPOSITORY 未设置"
[[ -n "${RESTIC_PASSWORD:-}" ]] || fail "RESTIC_PASSWORD 未设置"
[[ -r "$here/lib/table-counts.sql" ]] || fail "缺少 scripts/lib/table-counts.sql"

# ---------------------------------------------------------------------------
phase_begin "检查服务已停止"
step="连接 PostgreSQL（postgres 必须在运行）"
psql -X -q -At -d postgres -c 'select 1' >/dev/null
step="检查数据库连接"
active=$(psql -X -q -At -d postgres -c \
  "select coalesce(string_agg(distinct datname, ','), '') from pg_stat_activity
   where pid <> pg_backend_pid() and datname is not null and datname <> 'postgres'")
[[ -z "$active" ]] || fail "还有程序连着数据库（$active）。请先执行：$STOP_HINT"
if (( do_files )); then
  step="检查对象存储已停止"
  if wget -q -T 3 -t 1 -O /dev/null "$RUSTFS_URL" 2>/dev/null; then
    fail "对象存储 rustfs 还在运行。请先执行：$STOP_HINT"
  fi
  [[ -d "$files_dir" && -w "$files_dir" ]] \
    || fail "对象存储卷没有可写地挂载到 $files_dir（请用 restore 服务，或加 --no-files）"
fi
phase_end check

# ---------------------------------------------------------------------------
phase_begin "下载快照（$snapshot）"
step="查找快照 $snapshot"
if [[ "$snapshot" == "latest" ]]; then
  snapshot_id=$(restic snapshots "${restic_filter[@]}" --latest 1 --json | jq -r 'map(.id) | last // empty')
else
  snapshot_id=$(restic snapshots "${restic_filter[@]}" --json "$snapshot" | jq -r '.[0].id // empty')
fi
[[ -n "$snapshot_id" ]] || fail "仓库里找不到快照 $snapshot"
log "快照 ${snapshot_id:0:8}"
work=$(mktemp -d /tmp/aroomo-restore.XXXXXX)
step="下载数据库备份"
restic restore "$snapshot_id" --target "$work" --include "$STAGE" >&2
src="$work$STAGE"
[[ -f "$src/manifest.json" ]] || fail "快照里没有 manifest.json（不是本脚本生成的备份？）"
mapfile -t dumps < <(find "$src/db" -maxdepth 1 -name '*.dump' | sort)
(( ${#dumps[@]} > 0 )) || fail "快照里没有数据库备份"
phase_end fetch

# ---------------------------------------------------------------------------
phase_begin "恢复角色"
# 角色已存在等报错是预期的；--no-role-passwords 的 dump 不会改动现有密码
psql -X -q -v ON_ERROR_STOP=0 -d postgres -f "$src/globals.sql" >/dev/null 2>"$work/globals.log" || true
log "  角色脚本提示 $(grep -c 'ERROR' "$work/globals.log" || true) 条（已存在的角色会报错，属正常）"
phase_end globals

phase_begin "恢复数据库"
restored_dbs=()
for f in "${dumps[@]}"; do
  db=$(basename "$f" .dump)
  step="恢复数据库 $db"
  log "  $db"
  if ! pg_restore --no-password --clean --if-exists --create -d postgres "$f" 2>"$work/$db.log"; then
    # 例如扩展注释、pg_cron 只能装在 postgres 库等非致命问题；以下面的行数核对为准
    log "  $db：pg_restore 有 $(grep -c 'error' "$work/$db.log" || true) 条提示（以行数核对为准）："
    grep 'error' "$work/$db.log" | head -5 >&2 || true
  fi
  restored_dbs+=("$db")
done
phase_end databases

# ---------------------------------------------------------------------------
files_restored=false
if (( do_files )); then
  phase_begin "恢复对象存储文件"
  step="检查快照里的对象存储"
  if restic ls --json "$snapshot_id" "$FILES_PATH" 2>/dev/null | jq -e 'select(.struct_type == "node")' >/dev/null; then
    step="清空对象存储卷"
    find "$files_dir" -mindepth 1 -delete
    step="写回对象存储文件"
    restic restore "$snapshot_id" --target "${RESTORE_ROOT%/}/" --include "$FILES_PATH" >&2
    files_restored=true
  else
    log "  快照里没有对象存储数据，跳过"
  fi
  phase_end files
fi

# ---------------------------------------------------------------------------
verified=false
if (( do_verify )); then
  phase_begin "校验（逐表核对行数）"
  mismatch=0
  for db in "${restored_dbs[@]}"; do
    step="校验数据库 $db"
    psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -d "$db" -f "$here/lib/table-counts.sql" >"$work/$db.after.tsv"
    expected_tables=$(wc -l <"$src/db/$db.counts.tsv" | tr -d ' ')
    actual_tables=$(wc -l <"$work/$db.after.tsv" | tr -d ' ')
    if (( expected_tables > 0 && actual_tables == 0 )); then
      log "  ✗ $db：恢复后没有表（备份时 $expected_tables 张）"; mismatch=1; continue
    fi
    if diff -u "$src/db/$db.counts.tsv" "$work/$db.after.tsv" >"$work/$db.diff"; then
      rows=$(awk -F '\t' '{s+=$2} END {print s+0}' "$work/$db.after.tsv")
      log "  ✓ $db：$actual_tables 张表、$rows 行，与备份一致"
    else
      log "  ✗ $db：行数与备份不一致："; head -20 "$work/$db.diff" >&2; mismatch=1
    fi
  done
  (( mismatch == 0 )) || fail "恢复后的数据与备份不一致（见上方差异）"
  verified=true
  phase_end verify
fi

dur=$(( $(date +%s) - started_epoch ))
log "完成，总用时 ${dur} 秒。下一步：docker compose up -d"
printf '{"event":"restore","status":"ok","started_at":"%s","duration_s":%s,"snapshot_id":"%s","databases":%s,"files_restored":%s,"verified":%s,"phases":{%s}}\n' \
  "$started_at" "$dur" "$snapshot_id" "${#restored_dbs[@]}" "$files_restored" "$verified" "$phases"
