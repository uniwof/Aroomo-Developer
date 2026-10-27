# 备份 sidecar：PostgreSQL 17 客户端（pg_dumpall 与服务器同为 17）+ restic
FROM restic/restic:0.19.1 AS restic

FROM postgres:17.11-alpine3.24
RUN apk add --no-cache ca-certificates tzdata bash jq
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY entrypoint.sh /usr/local/bin/aroomo-backup-entrypoint
RUN chmod +x /usr/local/bin/aroomo-backup-entrypoint
ENTRYPOINT ["/usr/local/bin/aroomo-backup-entrypoint"]
