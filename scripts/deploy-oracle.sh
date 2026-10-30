#!/usr/bin/env bash
# 甲骨文 arm64 部署/回滚（新脚本，不复用旧 deploy.py）。
# 用法：
#   scripts/deploy-oracle.sh preflight   只检查（架构、Docker、磁盘、compose 配置），不改任何东西
#   scripts/deploy-oracle.sh deploy      在服务器上拉取 dev/main 指定提交并 compose up -d（会先记录回滚点）
#   scripts/deploy-oracle.sh rollback    回到上一个回滚点并重启
#   scripts/deploy-oracle.sh firewall    打印需要执行的 iptables 命令（dry-run）；加 --apply 才执行
# 变量：AROOMO_DIR（默认 /srv/aroomo）AROOMO_REF（默认 origin/main）PORTS（默认 "80 443"）
# 恢复备份见 docs/ops/BACKUP.md（restore.sh，需要 age 主密钥，只在恢复时临时提供）。
# 不含任何密码/Key；.env 由人工放在 $AROOMO_DIR/deploy/.env（权限 600）。
set -Eeuo pipefail
dir="${AROOMO_DIR:-/srv/aroomo}"
ref="${AROOMO_REF:-origin/main}"
ports="${PORTS:-80 443}"
state="$dir/.deploy-prev"
cmd="${1:-preflight}"; shift || true

die(){ echo "deploy-oracle: $*" >&2; exit 1; }

preflight(){
  [[ "$(uname -m)" == "aarch64" ]] || die "不是 arm64 机器"
  command -v docker >/dev/null || die "未安装 Docker"
  docker compose version >/dev/null || die "缺 compose 插件"
  local free; free=$(df -BG --output=avail "$(dirname "$dir")" | tail -1 | tr -dc 0-9)
  (( free >= 20 )) || die "磁盘剩余不足 20G"
  [[ -f "$dir/deploy/.env" ]] || echo "提示：$dir/deploy/.env 还不存在（正式部署前需放好，权限 600）" >&2
  if [[ -d "$dir/.git" ]]; then (cd "$dir" && scripts/compose.sh config -q) && echo "compose 配置通过"; fi
  echo "preflight 通过"
}

deploy(){
  preflight
  [[ -f "$dir/deploy/.env" ]] || die "缺 .env，拒绝部署"
  cd "$dir"
  git rev-parse HEAD > "$state"
  git fetch -q origin
  git checkout -q --detach "$ref"
  scripts/compose.sh pull
  scripts/compose.sh up -d --remove-orphans
  echo "已部署 $(git rev-parse --short HEAD)；回滚点 $(cut -c1-7 "$state")"
}

rollback(){
  cd "$dir"
  [[ -s "$state" ]] || die "没有回滚点"
  git checkout -q --detach "$(cat "$state")"
  scripts/compose.sh up -d --remove-orphans
  echo "已回滚到 $(git rev-parse --short HEAD)（数据库如需回退请用 restore.sh，不可逆，需确认）"
}

firewall(){
  local apply=0; [[ "${1:-}" == "--apply" ]] && apply=1
  # 插在最后一条 REJECT 之前（甲骨文 Ubuntu 镜像默认 INPUT 末尾有 REJECT）
  local n; n=$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/{l=$1} END{print l+0}')
  (( n > 0 )) || die "INPUT 里没找到 REJECT 规则"
  for p in $ports; do
    local c=(iptables -I INPUT "$n" -p tcp --dport "$p" -m state --state NEW -j ACCEPT)
    if (( apply )); then sudo "${c[@]}"; n=$((n+1)); else echo "sudo ${c[*]}"; fi
  done
  if (( apply )); then sudo netfilter-persistent save; else echo "sudo netfilter-persistent save"; fi
  echo "另需：VCN（vcn-free）安全列表放行同样端口 —— 需要主会话（浏览器操作）" >&2
}

case "$cmd" in
  preflight) preflight;; deploy) deploy;; rollback) rollback;; firewall) firewall "$@";;
  *) die "未知命令 $cmd";;
esac
