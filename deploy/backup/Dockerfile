# 备份 sidecar：PostgreSQL 17 客户端（pg_dumpall 与服务器同为 17）+ age（公钥加密，D64）+ rclone（S3 上传）+ zstd + GNU tar
FROM postgres:17.11-alpine3.24
RUN apk add --no-cache ca-certificates tzdata bash jq age rclone zstd tar coreutils
COPY entrypoint.sh /usr/local/bin/aroomo-backup-entrypoint
RUN chmod +x /usr/local/bin/aroomo-backup-entrypoint
ENTRYPOINT ["/usr/local/bin/aroomo-backup-entrypoint"]
