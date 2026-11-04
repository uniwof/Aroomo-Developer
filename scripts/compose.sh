#!/usr/bin/env bash
# 组合 compose 文件的薄封装：自动加上档位文件；可选叠加 local.yml / data-dir.yml。
#
#   scripts/compose.sh up -d                    # 服务器：基础 + 自动档位
#   AROOMO_LOCAL=1 scripts/compose.sh up -d     # 本机：再绑定 127.0.0.1 端口
#   AROOMO_TIER=standard scripts/compose.sh config
#   DATA_DIR=/srv/aroomo AROOMO_DATA_DIR=1 scripts/compose.sh up -d
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/../deploy"
tier="${AROOMO_TIER:-$("$here/select-tier.sh")}"

files=(-f "$deploy/docker-compose.yml" -f "$deploy/tiers/$tier.yml")
[[ "${AROOMO_LOCAL:-0}" == "1" ]] && files+=(-f "$deploy/local.yml")
[[ "${AROOMO_DATA_DIR:-0}" == "1" ]] && files+=(-f "$deploy/data-dir.yml")

if [[ ! -f "$deploy/tiers/$tier.yml" ]]; then
  echo "compose.sh: 未知档位 $tier" >&2
  exit 2
fi

exec docker compose --project-directory "$deploy" "${files[@]}" "$@"
