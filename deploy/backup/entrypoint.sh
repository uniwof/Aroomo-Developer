#!/bin/bash
# 备份 sidecar 入口：按 BACKUP_CRON（容器时区 TZ）定时执行 /opt/aroomo/scripts/backup.sh。
#   docker compose --profile backup run --rm backup now        立即备份一次
#   docker compose --profile backup run --rm backup snapshots  列出快照
# 恢复用单独的 restore 服务（对象存储卷可写），见 docs/ops/BACKUP.md。
set -euo pipefail

case "${1:-}" in
  now) exec /opt/aroomo/scripts/backup.sh ;;
  snapshots) exec restic snapshots --host "${BACKUP_HOST_TAG:-aroomo}" --tag aroomo ;;
  restore) shift; exec /opt/aroomo/scripts/restore.sh "$@" ;;
esac

if [[ -z "${RESTIC_REPOSITORY:-}" || -z "${RESTIC_PASSWORD:-}" ]]; then
  echo "backup: RESTIC_REPOSITORY / RESTIC_PASSWORD 未设置，sidecar 空转（不备份）" >&2
  exec sleep infinity
fi

# busybox crond 启动的任务拿不到容器环境变量：把备份需要的变量写进只有 root 可读的文件
env_file=/run/aroomo-backup.env
umask 077
: >"$env_file"
while IFS= read -r name; do
  printf 'export %s=%q\n' "$name" "${!name}" >>"$env_file"
done < <(compgen -e | grep -E '^(RESTIC_|AWS_|PG|BACKUP_|RETENTION_|TZ$)')

echo "${BACKUP_CRON:-30 3 * * *} . $env_file && /opt/aroomo/scripts/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root
echo "backup: schedule '${BACKUP_CRON:-30 3 * * *}' (TZ=${TZ:-UTC})"
exec crond -f -l 8
