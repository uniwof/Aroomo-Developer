#!/bin/bash
# 备份 sidecar 入口：按 BACKUP_CRON（容器时区 TZ）定时执行 /opt/aroomo/scripts/backup.sh。
# 也可以手动：docker compose run --rm backup now
set -euo pipefail

if [[ "${1:-}" == "now" ]]; then
  exec /opt/aroomo/scripts/backup.sh
fi
if [[ "${1:-}" == "restore" ]]; then
  shift
  exec /opt/aroomo/scripts/restore.sh "$@"
fi

if [[ -z "${RESTIC_REPOSITORY:-}" || -z "${RESTIC_PASSWORD:-}" ]]; then
  echo "backup: RESTIC_REPOSITORY / RESTIC_PASSWORD 未设置，sidecar 空转（不备份）" >&2
  exec sleep infinity
fi

echo "${BACKUP_CRON:-30 3 * * *} /opt/aroomo/scripts/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "backup: schedule '${BACKUP_CRON:-30 3 * * *}' (TZ=${TZ:-UTC})"
exec crond -f -l 8
