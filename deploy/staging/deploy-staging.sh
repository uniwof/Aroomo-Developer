#!/usr/bin/env bash
# Aroomo staging 部署脚本（工单 #170 / D209）。只在服务器 /opt/aroomo-staging 上运行，绝不碰生产 /opt/aroomo。
#
# 流程：git fetch → reset 到 origin/dev → （控制台有改动才重建）→ 构建 core/shell → up -d
#       → 把 staging Shell 接进生产网络（只给 cloudflared 用）→ 健康检查 → 失败回滚到上一个部署成功的提交。
#
# 触发方式（三种都调用这一个脚本，flock 保证同一时间只跑一个）：
#   1. systemd timer 每 2 分钟：deploy-staging.sh --if-changed（有新提交才部署；上次失败的同一提交不重试）
#   2. GitHub Actions（Secrets 到位后）：ssh 部署专用密钥 → authorized_keys 的 command= 强制运行本脚本
#      （SSH_ORIGINAL_COMMAND=status 只看状态；其他一律当作「有新提交就部署」）
#   3. 手动：deploy-staging.sh [--force] | status
#
# 状态文件（不含任何秘密）：$STAGING_ROOT/.deploy/{current,failed,history.log}
# 本脚本不打印任何密钥；.env 只由 compose 读取。
set -Eeuo pipefail

STAGING_ROOT="${STAGING_ROOT:-/opt/aroomo-staging}"
PROD_NETWORK="${STAGING_PROD_NETWORK:-aroomo_aroomo}"
SHELL_ALIAS=aroomo-staging-shell
PROJECT=aroomo-staging
SERVICES=(postgres redis rustfs rustfs-init core lobe shell)
HEALTH_TIMEOUT_S="${STAGING_HEALTH_TIMEOUT_S:-420}"
MIN_AVAILABLE_MB="${STAGING_MIN_AVAILABLE_MB:-350}"

# 把自己复制到临时文件再执行：git reset 会替换本文件，正在运行的脚本不能被改到一半
if [ -z "${STAGING_DEPLOY_COPY:-}" ]; then
  tmp="$(mktemp /tmp/deploy-staging.XXXXXX)"
  cp "$0" "$tmp"
  STAGING_DEPLOY_COPY="$tmp" exec bash "$tmp" "$@"
fi
trap 'rm -f "$STAGING_DEPLOY_COPY"' EXIT

state="$STAGING_ROOT/.deploy"
mkdir -p "$state"
log() { printf '%s %s\n' "$(date '+%F %T %Z')" "$*" | tee -a "$state/history.log"; }

mode=deploy
case "${SSH_ORIGINAL_COMMAND:-${1:-}}" in
  status) mode=status ;;
  --force|force) mode=force ;;
  --if-changed|"") mode=if-changed ;;
  *) mode=if-changed ;;
esac
# 来自 Actions（SSH）的部署：上次失败的提交也允许重试
from_ssh=0; [ -n "${SSH_ORIGINAL_COMMAND+x}" ] && from_ssh=1

git_() { git -C "$STAGING_ROOT" "$@"; }
dc() {
  docker compose -p "$PROJECT" --project-directory "$STAGING_ROOT/deploy" \
    --env-file "$STAGING_ROOT/deploy/.env" \
    -f "$STAGING_ROOT/deploy/docker-compose.yml" -f "$STAGING_ROOT/deploy/staging/compose.staging.yml" "$@"
}

if [ "$mode" = status ]; then
  echo "staging 当前提交：$(cat "$state/current" 2>/dev/null || echo 无)"
  echo "最近失败提交：$(cat "$state/failed" 2>/dev/null || echo 无)"
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Status}}'
  tail -n 5 "$state/history.log" 2>/dev/null || true
  exit 0
fi

exec 9>"$state/lock"
if ! flock -n 9; then echo "另一个部署正在进行，跳过"; exit 0; fi

git_ fetch -q origin dev
target="$(git_ rev-parse origin/dev)"
current="$(cat "$state/current" 2>/dev/null || true)"

if [ "$mode" != force ] && [ "$target" = "$current" ]; then
  exit 0
fi
if [ "$mode" = if-changed ] && [ "$from_ssh" = 0 ] && [ "$target" = "$(cat "$state/failed" 2>/dev/null || true)" ]; then
  exit 0
fi

# 保护生产：可用内存太少就先不部署（下一轮再试），绝不和生产抢内存
avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "$avail_mb" -lt "$MIN_AVAILABLE_MB" ]; then
  log "跳过 ${target:0:7}：可用内存 ${avail_mb}MB < ${MIN_AVAILABLE_MB}MB"
  exit 0
fi

wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S )) s ok
  while :; do
    ok=1
    for s in core lobe shell; do
      local id st
      id="$(dc ps -q "$s" 2>/dev/null || true)"
      st="$( [ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)"
      [ "$st" = healthy ] || ok=0
    done
    [ "$ok" = 1 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && { for s in core lobe shell; do echo "  $s: $(dc ps --format '{{.Status}}' "$s" 2>/dev/null)"; done; return 1; }
    sleep 5
  done
}

connect_edge() {
  local id
  id="$(dc ps -q shell)"
  [ -n "$id" ] || return 1
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' "$id" | grep -q "\"$PROD_NETWORK\""; then
    docker network connect --alias "$SHELL_ALIAS" "$PROD_NETWORK" "$id"
  fi
}

build_console_if_needed() {
  local from="$1" to="$2"
  if [ ! -f "$STAGING_ROOT/web/console/dist/index.html" ] || [ -z "$from" ] \
     || ! git_ diff --quiet "$from" "$to" -- web/console 2>/dev/null; then
    log "构建控制台 ${to:0:7}"
    docker run --rm --memory 1g -v "$STAGING_ROOT/web/console:/w" -w /w -e npm_config_update_notifier=false \
      node:22.23.4-alpine3.24 sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run build' >/dev/null
    test -f "$STAGING_ROOT/web/console/dist/index.html"
  fi
}

deploy_commit() {
  # 在 if 里调用时 set -e 不生效，所以每一步都显式 || return 1
  local sha="$1" prev="$2"
  git_ reset -q --hard "$sha" || return 1
  build_console_if_needed "$prev" "$sha" || { log "控制台构建失败"; return 1; }
  export STAGING_COMMIT="$sha"
  dc build -q core shell || { log "镜像构建失败"; return 1; }
  dc up -d --no-build --quiet-pull "${SERVICES[@]}" || { log "compose up 失败"; return 1; }
  connect_edge || { log "接入 cloudflared 网络失败"; return 1; }
  wait_healthy || { log "健康检查超时"; return 1; }
}

log "开始部署 ${target:0:7}（上一个 ${current:0:7}，模式 $mode）"
if deploy_commit "$target" "$current"; then
  echo "$target" >"$state/current"
  rm -f "$state/failed"
  log "部署成功 ${target:0:7} $(git_ log -1 --format=%s "$target" | cut -c1-80)"
  exit 0
fi

echo "$target" >"$state/failed"
log "部署失败 ${target:0:7}"
if [ -n "$current" ] && [ "$current" != "$target" ]; then
  log "回滚到 ${current:0:7}"
  if deploy_commit "$current" "$target"; then
    log "回滚成功，staging 仍是 ${current:0:7}"
  else
    log "回滚也失败，需要人工处理"
  fi
fi
exit 1
