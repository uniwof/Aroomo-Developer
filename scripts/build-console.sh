#!/usr/bin/env bash
# 构建控制台静态文件到 web/console/dist（用与 Core 同版本的 node 镜像，主机不需要装 node）。
# 部署时 deploy/docker-compose.yml 把 dist 只读挂进 Core 的 /app/console，Core 在 /console 提供。
set -euo pipefail
cd "$(dirname "$0")/../web/console"
docker run --rm -v "$PWD:/w" -w /w -e npm_config_update_notifier=false node:22.23.4-alpine3.24 \
  sh -c 'npm ci --no-audit --no-fund && npm run build'
test -f dist/index.html && echo "console built"
