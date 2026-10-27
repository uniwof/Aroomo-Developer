#!/usr/bin/env bash
# 备份（在 backup sidecar 容器内运行）：PostgreSQL 全量逻辑备份 + 对象存储数据 + 配置 → restic 仓库。
# 仓库必须在 AWS 之外（DECISIONS v4.3 e），restic 默认对数据加密（RESTIC_PASSWORD）。
#
# ⚠ 骨架版本：保留策略、完整性检查、失败通知、耗时记录由 Jules Issue（restic 备份/恢复脚本）完善。
#
# 环境变量：RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
#           PGHOST PGUSER PGPASSWORD（由 compose 注入）
# 不备份的内容：deploy/.env（含 LITELLM_SALT_KEY 等主密钥）——由用户离线另存，见 deploy/README.md。
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY 未设置}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD 未设置}"

started=$(date +%s)
tag="aroomo"
host="${BACKUP_HOST_TAG:-aroomo}"

if ! restic cat config >/dev/null 2>&1; then
  echo "backup: 初始化 restic 仓库"
  restic init
fi

echo "backup: 导出 PostgreSQL"
pg_dumpall --clean --if-exists \
  | restic backup --host "$host" --tag "$tag" --tag postgres --stdin --stdin-filename postgres.sql

echo "backup: 备份对象存储与配置"
restic backup --host "$host" --tag "$tag" --tag files /data/rustfs /data/config

echo "backup: 清理旧快照（7 天 / 4 周 / 6 月）"
restic forget --host "$host" --tag "$tag" --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

echo "backup: 完成，用时 $(( $(date +%s) - started )) 秒"
