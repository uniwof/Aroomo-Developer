#!/usr/bin/env bash
# 恢复（在 restore 容器内运行；与 backup 同一镜像，但对象存储卷可写）。
# ⚠ 会删除并重建数据库、清空对象存储卷，不可逆。必须带 --yes-overwrite-database 才执行（D50/D63：不可逆操作要确认）。
#
# 需要主密钥（age 私钥，AGE-SECRET-KEY-1 开头，D64）。只在这一步临时提供，不写进任何文件：
#   - 交互：直接运行，脚本会提示输入（输入时不显示）；
#   - 非交互：read -rs AROOMO_BACKUP_IDENTITY; export AROOMO_BACKUP_IDENTITY
#             docker compose --profile restore run --rm -e AROOMO_BACKUP_IDENTITY restore --yes-overwrite-database
#     （-e 只写变量名，值从当前终端取，不会出现在命令行和 shell 历史里）
#
#   docker compose --profile restore run --rm restore --list
#   docker compose stop lobe litellm core rustfs          # 先停服务（脚本会检查）
#   docker compose --profile restore run --rm restore --yes-overwrite-database [备份名|latest]
#   docker compose up -d
#
# 选项：--no-files     只恢复数据库，不动对象存储
#       --no-secrets   不写出备份里的 .env
#       --skip-verify  不做行数核对（不推荐）
#       --from local|offsite  从哪里取（默认：配置了异地存储就从异地，否则本机）
# 环境变量：BACKUP_S3_* / BACKUP_LOCAL_DIR（同 backup.sh）PGHOST PGUSER PGPASSWORD
#           AROOMO_BACKUP_IDENTITY 或 AROOMO_BACKUP_IDENTITY_FILE（主密钥，只在恢复时）
#           RESTORE_ROOT（默认 /restore-root；对象存储卷挂在 $RESTORE_ROOT/data/rustfs）
#           RESTORE_SECRETS_DIR（默认 /restore-secrets；备份里的 .env 写到这里的 aroomo.env，权限 600）
#           RESTORE_RUSTFS_URL（默认 http://rustfs:9000/health，用来确认 rustfs 已停止）
#
# 输出：过程日志写 stderr；最后一行 JSON（含各阶段耗时）写 stdout。失败时非零退出并输出一行中文原因。
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/backup-common.sh
. "$here/lib/backup-common.sh"

STAGE_REL="backup-stage"
RESTORE_ROOT="${RESTORE_ROOT:-/restore-root}"
RUSTFS_URL="${RESTORE_RUSTFS_URL:-http://rustfs:9000/health}"
SECRETS_DIR="${RESTORE_SECRETS_DIR:-/restore-secrets}"
files_dir="${RESTORE_ROOT%/}/data/rustfs"
STOP_HINT="docker compose stop lobe litellm core rustfs"

step="启动"
started_epoch=$(date +%s)
started_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
work=""
phases=""
IDENTITY=""

log() { printf 'restore: %s\n' "$*" >&2; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cleanup() { IDENTITY=""; [[ -n "$work" && -d "$work" ]] && rm -rf "$work"; return 0; }
trap cleanup EXIT

on_error() {
  local code=$?
  # 子 shell（命令替换、管道）里的失败只退出子 shell，不在这里重复输出结果 JSON
  if (( BASH_SUBSHELL > 0 )); then exit "$code"; fi
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

# ---------------------------------------------------------------------------
source_kind=""
pick_source() {
  case "$source_kind" in
    local) [[ -n "${BACKUP_LOCAL_DIR:-}" ]] || fail "BACKUP_LOCAL_DIR 未设置，不能 --from local" ;;
    offsite) offsite_configured || fail "没有配置异地存储（BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET），不能 --from offsite" ;;
    "") if offsite_configured; then source_kind=offsite; elif [[ -n "${BACKUP_LOCAL_DIR:-}" ]]; then source_kind=local; else fail "没有配置备份位置"; fi ;;
    *) fail "--from 只能是 local 或 offsite" ;;
  esac
  [[ "$source_kind" == offsite ]] && offsite_setup
  return 0
}

if [[ "${1:-}" == "--list" ]]; then
  shift
  [[ "${1:-}" == "--from" ]] && source_kind="${2:-}"
  pick_source
  log "备份位置：$source_kind（旧 → 新）"
  list_backups "$source_kind"
  exit 0
fi
if [[ "${1:-}" != "--yes-overwrite-database" ]]; then
  echo "restore: 这会删除并重建数据库、清空对象存储。确认请加参数 --yes-overwrite-database [备份名]" >&2
  exit 64
fi
shift

snapshot="latest"
do_files=1
do_verify=1
do_secrets=1
while (( $# )); do
  case "$1" in
    --no-files) do_files=0 ;;
    --no-secrets) do_secrets=0 ;;
    --skip-verify) do_verify=0 ;;
    --from) source_kind="${2:-}"; shift ;;
    -*) echo "restore: 未知参数 $1" >&2; exit 64 ;;
    *) snapshot="$1" ;;
  esac
  shift
done

step="检查环境"
[[ -r "$here/lib/table-counts.sql" ]] || fail "缺少 scripts/lib/table-counts.sql"
pick_source

step="读取主密钥"
if [[ -n "${AROOMO_BACKUP_IDENTITY:-}" ]]; then
  IDENTITY="$AROOMO_BACKUP_IDENTITY"
elif [[ -n "${AROOMO_BACKUP_IDENTITY_FILE:-}" ]]; then
  IDENTITY="$(grep -E '^AGE-SECRET-KEY-1' "$AROOMO_BACKUP_IDENTITY_FILE" | head -1)"
elif [[ -t 0 ]]; then
  printf '请输入主密钥（AGE-SECRET-KEY-1 开头；输入时屏幕上不显示，输完按回车）：' >&2
  IFS= read -rs IDENTITY
  printf '\n' >&2
else
  fail "需要主密钥：设置 AROOMO_BACKUP_IDENTITY（docker compose run -e AROOMO_BACKUP_IDENTITY …），或在终端里交互运行"
fi
unset AROOMO_BACKUP_IDENTITY
IDENTITY="$(printf '%s' "$IDENTITY" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
[[ "$IDENTITY" =~ $AROOMO_AGE_IDENTITY_RE ]] || fail "主密钥格式不对（应为 AGE-SECRET-KEY-1 开头的 74 个字符）"
step="由主密钥推出公钥"
pubkey="$(age-keygen -y <(printf '%s\n' "$IDENTITY"))"

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
phase_begin "取回备份（$snapshot，来自 $source_kind）"
step="查找备份 $snapshot"
mapfile -t all < <(list_backups "$source_kind")
(( ${#all[@]} > 0 )) || fail "$source_kind 里没有任何备份"
if [[ "$snapshot" == "latest" ]]; then
  file="${all[-1]}"
else
  file=""
  for f in "${all[@]}"; do [[ "$f" == *"$snapshot"* ]] && file="$f"; done
  [[ -n "$file" ]] || fail "找不到备份 $snapshot"
fi
base="${file%.tar.zst.age}"
log "备份 $base"
work=$(mktemp -d /tmp/aroomo-restore.XXXXXX)
chmod 700 "$work"
step="下载备份"
if [[ "$source_kind" == offsite ]]; then
  rclone copyto "$(offsite_dir)/$file" "$work/$file"
  rclone copyto "$(offsite_dir)/$base.meta.json" "$work/$base.meta.json" 2>/dev/null || log "  没有 .meta.json，跳过 SHA-256 核对"
else
  cp "$BACKUP_LOCAL_DIR/$file" "$work/$file"
  cp "$BACKUP_LOCAL_DIR/$base.meta.json" "$work/$base.meta.json" 2>/dev/null || log "  没有 .meta.json，跳过 SHA-256 核对"
fi
if [[ -f "$work/$base.meta.json" ]]; then
  step="核对 SHA-256"
  want=$(jq -r '.sha256 // empty' "$work/$base.meta.json")
  got=$(sha256sum "$work/$file" | cut -d' ' -f1)
  [[ -z "$want" || "$want" == "$got" ]] || fail "备份文件的 SHA-256 与记录不一致（文件损坏）"
  recipient=$(jq -r '.recipient // empty' "$work/$base.meta.json")
  [[ -z "$recipient" || "$recipient" == "$pubkey" ]] \
    || fail "主密钥不对：这份备份是用另一把主密钥的公钥加密的（${recipient:0:12}…），你提供的主密钥对应 ${pubkey:0:12}…"
fi
step="用主密钥解密并解压"
mkdir -p "$work/x"
age -d -i <(printf '%s\n' "$IDENTITY") "$work/$file" | zstd -dc | tar -C "$work/x" -xf -
IDENTITY=""
rm -f "$work/$file"
src="$work/x/$STAGE_REL"
[[ -f "$src/manifest.json" ]] || fail "备份里没有 manifest.json（不是本脚本生成的备份？）"
mapfile -t dumps < <(find "$src/db" -maxdepth 1 -name '*.dump' | sort)
(( ${#dumps[@]} > 0 )) || fail "备份里没有数据库导出"
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
  if [[ -d "$work/x/data/rustfs" ]]; then
    step="清空对象存储卷"
    find "$files_dir" -mindepth 1 -delete
    step="写回对象存储文件"
    cp -a "$work/x/data/rustfs/." "$files_dir/"
    files_restored=true
  else
    log "  备份里没有对象存储数据，跳过"
  fi
  phase_end files
fi

secrets_in_backup=false
secrets_written=false
if [[ -f "$work/x/data/secrets/aroomo.env" ]]; then
  secrets_in_backup=true
  if (( do_secrets )) && [[ -d "$SECRETS_DIR" && -w "$SECRETS_DIR" ]]; then
    step="写出备份里的 .env"
    install -m 600 "$work/x/data/secrets/aroomo.env" "$SECRETS_DIR/aroomo.env"
    secrets_written=true
    log "  备份里的 .env 已写到 deploy/.restore/aroomo.env（权限 600）。核对后用它替换 deploy/.env（特别是 LITELLM_SALT_KEY），然后删除这个文件。"
  fi
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
printf '{"event":"restore","status":"ok","started_at":"%s","duration_s":%s,"snapshot_id":"%s","source":"%s","databases":%s,"files_restored":%s,"secrets_in_backup":%s,"secrets_written":%s,"verified":%s,"phases":{%s}}\n' \
  "$started_at" "$dur" "$base" "$source_kind" "${#restored_dbs[@]}" "$files_restored" "$secrets_in_backup" "$secrets_written" "$verified" "$phases"
