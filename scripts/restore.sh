#!/usr/bin/env bash
# 恢复（在 backup sidecar 容器内运行）。⚠ 会覆盖现有数据库，属于不可逆操作，
# 必须带 --yes-overwrite-database 才执行（DECISIONS v4.3：不可逆操作二次确认）。
#
#   docker compose --profile backup run --rm backup restore --list
#   docker compose --profile backup run --rm backup restore --yes-overwrite-database [snapshot-id]
#
# 恢复前先停掉连接数据库的服务：docker compose stop lobe litellm core
#
# ⚠ 骨架版本：对象存储文件恢复、恢复后校验、恢复演练记录（耗时）由 Jules Issue 完善。
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY 未设置}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD 未设置}"

if [[ "${1:-}" == "--list" ]]; then
  exec restic snapshots --tag aroomo
fi

if [[ "${1:-}" != "--yes-overwrite-database" ]]; then
  echo "restore: 这会覆盖当前数据库。确认请加参数 --yes-overwrite-database [snapshot-id]" >&2
  exit 64
fi
snapshot="${2:-latest}"

started=$(date +%s)
echo "restore: 从快照 $snapshot 恢复 PostgreSQL"
restic dump --tag postgres "$snapshot" postgres.sql | psql -v ON_ERROR_STOP=0 --quiet postgres
echo "restore: 数据库恢复完成，用时 $(( $(date +%s) - started )) 秒"
echo "restore: 对象存储文件请用 restic restore --tag files 恢复到 rustfs 卷（待脚本完善）"
