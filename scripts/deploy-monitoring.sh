#!/usr/bin/env bash
# Aroomo Gatus (健康检查) 与 Beszel (资源监控) 部署及管理脚本
#
# 注意：
# 1. 本监控套件默认只在容器网络内运行，不对公网暴露端口。
# 2. 需通过 Cloudflare Tunnel + Cloudflare Access 配置域名与登录鉴权对外提供访问。
# 3. 部署操作不会自动触发，需手动执行本脚本。
#
# 用法：
#   scripts/deploy-monitoring.sh [up|down|status|config]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/../deploy"
env_file="$deploy/.env"

show_mobile_instructions() {
  cat << 'EOF'

======================================================================
  手机端 / 远程查看监控方式 (Mobile Viewing Guide)
======================================================================
1. 网络与安全 (非公网直接暴露，必须登录):
   - 监控服务 (Gatus / Beszel) 默认仅运行于 Docker 内部 Bridge 网络 (aroomo)。
   - 未在宿主机直接开放端口，避免公网未经授权访问。

2. 通过 Cloudflare Tunnel 配置二级域名路由 (推荐):
   - 在 Cloudflare 控制台添加两条路由:
     • 健康检查 (Gatus):   status.example.com  -> http://gatus:8080
     • 资源监控 (Beszel):  monitor.example.com -> http://beszel:8090
   - 在 Cloudflare Access 中为上述域名添加 Email 验证码或 SSO 鉴权策略。

3. 手机端访问体验:
   - 手机浏览器 (iOS Safari / Android Chrome) 打开配置好的 URL (如 https://monitor.example.com)。
   - 通过 Cloudflare Access 验证登录后即可查看仪表盘。
   - Beszel 支持 PWA 标准，可在手机浏览器中点击 "添加到主屏幕" (Add to Home Screen)，
     作为原生 App 快捷打开查看服务器 CPU、内存、磁盘与 Docker 容器实时负载。
======================================================================

EOF
}

cmd="${1:-up}"

if [[ ! -f "$env_file" ]]; then
  echo "警告: 未找到 $env_file 文件。请先基于 .env.example 创建并配置 .env" >&2
  if [[ "$cmd" == "up" ]]; then
    exit 1
  fi
fi

tier="${AROOMO_TIER:-$("$here/select-tier.sh")}"
files=(-f "$deploy/docker-compose.yml" -f "$deploy/tiers/$tier.yml" -f "$deploy/monitoring.yml")

case "$cmd" in
  up)
    echo "正在启动 Aroomo Gatus & Beszel 监控服务..."
    docker compose --project-directory "$deploy" "${files[@]}" --profile monitoring up -d gatus beszel beszel-agent
    echo "监控服务启动完成！"
    show_mobile_instructions
    ;;
  down)
    echo "正在停止并移除 Aroomo 监控服务..."
    docker compose --project-directory "$deploy" "${files[@]}" --profile monitoring stop gatus beszel beszel-agent
    docker compose --project-directory "$deploy" "${files[@]}" --profile monitoring rm -f gatus beszel beszel-agent
    echo "监控服务已停止。"
    ;;
  status)
    docker compose --project-directory "$deploy" "${files[@]}" --profile monitoring ps gatus beszel beszel-agent
    ;;
  config)
    docker compose --project-directory "$deploy" "${files[@]}" --profile monitoring config
    ;;
  *)
    echo "未知命令: $cmd" >&2
    echo "用法: $0 [up|down|status|config]" >&2
    exit 2
    ;;
esac
