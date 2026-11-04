#!/bin/bash
# 备份 sidecar 入口：按 BACKUP_CRON（容器时区 TZ）定时执行 /opt/aroomo/scripts/backup.sh。
#   docker compose --profile backup run --rm backup now        立即备份一次
#   docker compose --profile backup run --rm backup snapshots  列出备份
# 恢复用单独的 restore 服务（对象存储卷可写），见 docs/ops/BACKUP.md。
set -euo pipefail

case "${1:-}" in
  now) exec /opt/aroomo/scripts/backup.sh ;;
  snapshots) shift; exec /opt/aroomo/scripts/restore.sh --list "$@" ;;
  restore) shift; exec /opt/aroomo/scripts/restore.sh "$@" ;;
esac

if [[ -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  echo "backup: BACKUP_AGE_RECIPIENT（主密钥的公钥）未设置，sidecar 空转（不备份）" >&2
  exec sleep infinity
fi
if [[ -z "${BACKUP_S3_ENDPOINT:-}" && -z "${BACKUP_LOCAL_DIR:-}" ]]; then
  echo "backup: 没有备份目标（BACKUP_S3_* / BACKUP_LOCAL_DIR），sidecar 空转（不备份）" >&2
  exec sleep infinity
fi

# busybox crond 启动的任务拿不到容器环境变量：把备份需要的变量写进只有 root 可读的文件
env_file=/run/aroomo-backup.env
umask 077
: >"$env_file"
while IFS= read -r name; do
  printf 'export %s=%q\n' "$name" "${!name}" >>"$env_file"
done < <(compgen -e | grep -E '^(BACKUP_|RETENTION_|PG|TZ$)')

echo "${BACKUP_CRON:-30 3 * * *} . $env_file && /opt/aroomo/scripts/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root
echo "backup: schedule '${BACKUP_CRON:-30 3 * * *}' (TZ=${TZ:-UTC})"
exec crond -f -l 8
