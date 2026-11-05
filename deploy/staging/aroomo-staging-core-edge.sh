#!/usr/bin/env bash
# 仅 staging（2026-11-04 原生对话体验 #250）。绝不在生产使用：生产服务器上不要装这个脚本和它的 timer / service。
# 服务器上装在 /usr/local/bin/aroomo-staging-core-edge.sh，由 aroomo-staging-core-edge.timer 每分钟跑一次（幂等）。
#
# 做什么：一个只做 TCP 转发的 socat 小容器 aroomo-staging-core-edge，
#   一脚在 staging 网络（连 aroomo-staging-core:8080，staging 独有别名），
#   一脚在生产网络 aroomo_aroomo（别名 aroomo-staging-core-edge，给生产 cloudflared 用：chat-staging.pcmanai.com → 这里）。
#   staging Core 本身不进生产网络（避免它把 postgres/litellm 等名字解析到生产）。
#   chat-staging.pcmanai.com 在 Cloudflare Access 应用「Aroomo staging」后面（与 staging.pcmanai.com 同一应用）。
# 撤销：systemctl disable --now aroomo-staging-core-edge.timer; docker rm -f aroomo-staging-core-edge; 删除本脚本与 unit；
#       Cloudflare 删 tunnel 路由 chat-staging.pcmanai.com 与 Access 应用里的该域名。
set -u
N=aroomo-staging-core-edge
if ! docker ps -q -f "name=^$N\$" | grep -q .; then
  docker rm -f $N >/dev/null 2>&1 || true
  docker run -d --name $N --restart unless-stopped --memory 24m --cgroup-parent aroomo-staging.slice \
    --network aroomo-staging_aroomo --label org.aroomo.purpose=staging-native-chat-edge \
    alpine/socat:1.8.0.3 -d TCP-LISTEN:8080,fork,reuseaddr TCP:aroomo-staging-core:8080 >/dev/null
fi
docker inspect -f '{{json .NetworkSettings.Networks}}' $N | grep -q '"aroomo_aroomo"' || docker network connect --alias aroomo-staging-core-edge aroomo_aroomo $N
