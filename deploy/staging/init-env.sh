#!/usr/bin/env bash
# 在服务器上生成 staging 的 deploy/.env（工单 #170）。只在文件不存在时生成；已存在只补缺的键。
# 所有秘密值都在服务器上用 openssl / node 现场生成，不打印、不出服务器，文件权限 600。
#
#   /opt/aroomo-staging/deploy/staging/init-env.sh [CF_ACCESS_AUD]
#
# CF_ACCESS_AUD 是 Cloudflare Access 应用「Aroomo staging」的 Audience（不是秘密，但也不进仓库）。
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env="$root/deploy/.env"
aud="${1:-}"
touch "$env"
chmod 600 "$env"

has() { grep -q "^$1=" "$env"; }
put() { has "$1" || printf '%s=%s\n' "$1" "$2" >>"$env"; }
hex() { openssl rand -hex "$1"; }

put TZ Asia/Shanghai
put COMPOSE_PROFILES ''
put POSTGRES_PASSWORD "$(hex 24)"
put LOBE_DB_NAME lobechat
put LITELLM_DB_PASSWORD "$(hex 24)"
put CORE_DB_PASSWORD "$(hex 24)"
put RUSTFS_ACCESS_KEY "$(hex 12)"
put RUSTFS_SECRET_KEY "$(hex 24)"
put RUSTFS_LOBE_BUCKET lobe
put S3_ENDPOINT http://localhost:9000
put APP_URL https://staging.pcmanai.com
put KEY_VAULTS_SECRET "$(openssl rand -base64 32)"
put AUTH_SECRET "$(openssl rand -base64 32)"
put AUTH_ALLOWED_EMAILS tifni023@gmail.com
# 所有者的 LobeHub 用户 id（#245/#252：Shell 只认它，留空 = 控制台对所有人 403）。这里只留空变量，不写真实值；
# 所有者登录 staging 后打开 /api/auth/get-session 复制 user.id，再由主会话在服务器上填进 deploy/.env。
put SHELL_OWNER_USER_ID ''
put LOBE_ENABLE_AGENT_GATEWAY 0
# staging 不起 litellm；这两个值只为通过 compose 必填校验
put LITELLM_MASTER_KEY "sk-$(hex 24)"
put LITELLM_SALT_KEY "sk-$(hex 24)"
put LITELLM_NUM_WORKERS 1
put CORE_LOG_LEVEL info
put CORE_OWNER_TOKEN "$(hex 32)"
put CORE_CHAT_TOKEN "$(hex 32)"
put CORE_TOKEN_SECRET "$(hex 32)"
put VAULT_KEY "$(openssl rand -base64 32)"
put CF_ACCESS_TEAM_DOMAIN aroomo.cloudflareaccess.com
put CORE_ACCESS_REAUTH required
put CORE_ACCESS_REAUTH_MAX_AGE_S 300
# 不覆盖生产的 aroomo-core:dev / aroomo-shell:dev 镜像
put AROOMO_CORE_TAG staging
put AROOMO_SHELL_TAG staging
if [ -n "$aud" ]; then
  sed -i '/^CF_ACCESS_AUD=/d' "$env"
  printf 'CF_ACCESS_AUD=%s\n' "$aud" >>"$env"
else
  put CF_ACCESS_AUD ''
fi

# LobeHub 的 JWKS_KEY：含 RS256 私钥的 JWK Set（JSON 一行），用与 Core 同版本的 node 镜像生成
if ! grep -q "^JWKS_KEY='{" "$env"; then
  sed -i '/^JWKS_KEY=/d' "$env"
  jwks="$(docker run --rm --network none node:22.23.4-alpine3.24 node -e '
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = privateKey.export({ format: "jwk" });
process.stdout.write(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid: randomBytes(8).toString("hex") }] }));
')"
  printf "JWKS_KEY='%s'\n" "$jwks" >>"$env"
  unset jwks
fi

chmod 600 "$env"
echo "staging .env 就绪：$(grep -c '=' "$env") 个键（值不显示）"
