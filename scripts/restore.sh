#!/usr/bin/env bash
# 恢复（在 backup sidecar 容器内运行）。⚠ 会覆盖现有数据库，属于不可逆操作，
# 必须带 --yes-overwrite-database 才执行（DECISIONS v4.3：不可逆操作二次确认）。
#
#   docker compose --profile backup run --rm backup restore --list
#   docker compose --profile backup run --rm backup restore --yes-overwrite-database [snapshot-id]
#
# 恢复前先停掉连接数据库的服务：docker compose stop lobe litellm core
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY 未设置}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD 未设置}"

on_error() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "恢复失败：脚本在第 $1 行执行命令退出，错误码 $exit_code" >&2
  fi
}
trap 'on_error $LINENO' EXIT

if [[ "${1:-}" == "--list" ]]; then
  exec restic snapshots --tag aroomo
fi

if [[ "${1:-}" != "--yes-overwrite-database" ]]; then
  echo "restore: 这会覆盖当前数据库。确认请加参数 --yes-overwrite-database [snapshot-id]" >&2
  exit 64
fi
snapshot="${2:-latest}"

started=$(date +%s)

# 恢复前检查目标服务是否停止（是否有活跃的应用数据库连接）
echo "restore: 检查目标数据库连接状态..."
active_conns=$(psql -v ON_ERROR_STOP=1 -t -A -c "SELECT count(*) FROM pg_stat_activity WHERE datname IN ('lobechat', 'litellm', 'aroomo_core') AND pid <> pg_backend_pid();" postgres 2>/dev/null || echo "0")

if [[ "$active_conns" -gt 0 ]]; then
  echo "恢复失败：检测到 $active_conns 个活跃的应用数据库连接。恢复前请先停止连接数据库的服务：" >&2
  echo "  docker compose stop lobe litellm core" >&2
  exit 1
fi

echo "restore: 从快照 $snapshot 恢复 PostgreSQL..."
# pg_dumpall 导出的 SQL 包含 DROP ROLE/DATABASE postgres，psql 执行时会产生非致命警告/错误，使用 ON_ERROR_STOP=0 允许忽略此类无害警告
restic dump --tag postgres "$snapshot" postgres.sql | psql -v ON_ERROR_STOP=0 --quiet postgres

echo "restore: 恢复对象存储文件与配置..."
if [[ "$snapshot" == "latest" ]]; then
  restic restore latest --tag files --target / 2>/dev/null || true
else
  restic restore "$snapshot" --target / 2>/dev/null || true
fi

echo "restore: 校验数据库状态..."
for db in lobechat litellm aroomo_core; do
  table_count=$(psql -v ON_ERROR_STOP=1 -d "$db" -t -A -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');" 2>/dev/null || echo "0")
  if ! [[ "$table_count" =~ ^[0-9]+$ ]] || [[ "$table_count" -le 0 ]]; then
    echo "恢复校验失败：数据库 $db 无法连接或表数量为 0 (表数量: $table_count)" >&2
    exit 1
  fi
  echo "restore: 数据库 $db 校验通过 (表数量: $table_count)"
done

ended=$(date +%s)
echo "restore: 恢复完成，总耗时 $(( ended - started )) 秒"

trap - EXIT
