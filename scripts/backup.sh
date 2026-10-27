#!/usr/bin/env bash
# 备份（在 backup sidecar 容器内运行）：PostgreSQL 全量逻辑备份 + 对象存储数据 + 配置 → restic 仓库。
# 仓库必须在 AWS 之外（DECISIONS v4.3 e），restic 默认对数据加密（RESTIC_PASSWORD）。
#
# 环境变量：RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
#           PGHOST PGUSER PGPASSWORD（由 compose 注入）
#           KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY（可覆盖保留策略）
#           RESTIC_CHECK_SUBSET（可选，如 5%）
# 不备份的内容：deploy/.env（含 LITELLM_SALT_KEY 等主密钥）——由用户离线另存，见 deploy/README.md。
set -euo pipefail

started_epoch=$(date +%s)
started_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

tag="aroomo"
host="${BACKUP_HOST_TAG:-aroomo}"

keep_daily="${KEEP_DAILY:-7}"
keep_weekly="${KEEP_WEEKLY:-4}"
keep_monthly="${KEEP_MONTHLY:-6}"

# 捕获退出信号，若非正常完成（非 0）则输出中文错误信息到 stderr
on_error() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "备份失败：脚本在第 $1 行执行命令退出，错误码 $exit_code" >&2
  fi
}
trap 'on_error $LINENO' EXIT

if [[ -z "${RESTIC_REPOSITORY:-}" ]]; then
  echo "备份失败：RESTIC_REPOSITORY 未设置" >&2
  exit 1
fi

if [[ -z "${RESTIC_PASSWORD:-}" ]]; then
  echo "备份失败：RESTIC_PASSWORD 未设置" >&2
  exit 1
fi

if ! restic cat config >/dev/null 2>&1; then
  echo "backup: 初始化 restic 仓库" >&2
  if ! restic init >/dev/null 2>&1; then
    echo "备份失败：初始化 restic 仓库失败，请检查 Repository URL 与存储凭据" >&2
    exit 1
  fi
fi

echo "backup: 导出 PostgreSQL..." >&2
pg_json=$(pg_dumpall --clean --if-exists \
  | restic backup --host "$host" --tag "$tag" --tag postgres --stdin --stdin-filename postgres.sql --json)

pg_snapshot_id=$(echo "$pg_json" | grep '"message_type":"summary"' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("snapshot_id",""))')
pg_bytes=$(echo "$pg_json" | grep '"message_type":"summary"' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total_bytes_processed",0))')

echo "backup: 备份对象存储与配置..." >&2
backup_targets=()
[[ -d "/data/rustfs" ]] && backup_targets+=("/data/rustfs")
[[ -d "/data/config" ]] && backup_targets+=("/data/config")

if [[ ${#backup_targets[@]} -gt 0 ]]; then
  files_json=$(restic backup --host "$host" --tag "$tag" --tag files "${backup_targets[@]}" --json)
  files_snapshot_id=$(echo "$files_json" | grep '"message_type":"summary"' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("snapshot_id",""))')
  files_bytes=$(echo "$files_json" | grep '"message_type":"summary"' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total_bytes_processed",0))')
else
  files_snapshot_id=""
  files_bytes=0
fi

echo "backup: 清理旧快照（保留策略：日 $keep_daily / 周 $keep_weekly / 月 $keep_monthly）..." >&2
restic forget --host "$host" --tag "$tag" --keep-daily "$keep_daily" --keep-weekly "$keep_weekly" --keep-monthly "$keep_monthly" --prune >/dev/null

# 完整性检查：每周日或配置了 RESTIC_CHECK_SUBSET 时执行 restic check
day_of_week=$(date +%u)
check_subset="${RESTIC_CHECK_SUBSET:-}"
if [[ "$day_of_week" -eq 7 ]] || [[ -n "$check_subset" ]]; then
  subset="${check_subset:-5%}"
  echo "backup: 执行定期数据完整性检查 (--read-data-subset=$subset)..." >&2
  restic check "--read-data-subset=$subset" >&2
fi

ended_epoch=$(date +%s)
duration=$(( ended_epoch - started_epoch ))
total_bytes=$(( pg_bytes + files_bytes ))

snapshots_combined=""
if [[ -n "$pg_snapshot_id" && -n "$files_snapshot_id" ]]; then
  snapshots_combined="${pg_snapshot_id},${files_snapshot_id}"
elif [[ -n "$pg_snapshot_id" ]]; then
  snapshots_combined="$pg_snapshot_id"
else
  snapshots_combined="$files_snapshot_id"
fi

# 在 stdout 输出标准 JSON 格式结果
python3 -c '
import json, sys
data = {
    "start_time": sys.argv[1],
    "duration_seconds": int(sys.argv[2]),
    "snapshot_id": sys.argv[3],
    "postgres_snapshot_id": sys.argv[4],
    "files_snapshot_id": sys.argv[5],
    "total_bytes": int(sys.argv[6])
}
print(json.dumps(data))
' "$started_iso" "$duration" "$snapshots_combined" "$pg_snapshot_id" "$files_snapshot_id" "$total_bytes"

trap - EXIT
