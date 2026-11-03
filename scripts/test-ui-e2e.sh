#!/usr/bin/env bash
# 界面端到端冒烟（CI 的 ui-e2e job；本地有 Docker 也能跑）。只用占位凭据。
#   起完整栈（官方 LobeHub 镜像 + Aroomo Shell + Core + LiteLLM）→ 注册一个测试用户
#   → Playwright 打开首页 / 对话 / Aroomo 页面（电脑 1280×800 + 手机 390×844）→ 截图、导出页面结构 → 检查：
#   标题是 Aroomo、页面上看不到 LobeHub、§8 底部图标在、隐藏页面跳走、设置 6 个 Tab、朗读接口被禁用。
# 环境变量：E2E_REPORT_DIR（截图和报告输出目录，默认 ui-e2e-report/）
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
deploy="$root/deploy"
project=aroomo-ui
report="${E2E_REPORT_DIR:-$root/ui-e2e-report}"
mkdir -p "$report"
base=http://localhost:3210
email=ui-e2e@example.com
password="placeholder-$(openssl rand -hex 8)"

env_file="$(mktemp)"
python3 - "$deploy/.env.example" >"$env_file" <<'PY'
import base64, secrets, sys
for line in open(sys.argv[1], encoding='utf-8'):
    line = line.rstrip('\n')
    if line.startswith('KEY_VAULTS_SECRET='):
        # LobeHub 要求 base64 解码后正好 16/24/32 字节（openssl rand -base64 32）
        line = 'KEY_VAULTS_SECRET=' + base64.b64encode(secrets.token_bytes(32)).decode()
    elif line.endswith('=CHANGE_ME'):
        line = line[:-len('CHANGE_ME')] + secrets.token_hex(24)
    elif line.endswith('=sk-CHANGE_ME'):
        line = line[:-len('sk-CHANGE_ME')] + 'sk-' + secrets.token_hex(24)
    print(line)
PY
jwks="$(node -e '
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = privateKey.export({ format: "jwk" });
process.stdout.write(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid: randomBytes(8).toString("hex") }] }));
')"
{
  echo "JWKS_KEY='$jwks'"
  echo "AUTH_ALLOWED_EMAILS=$email"
  echo "CORE_ACCESS_REAUTH=off"
  echo "AROOMO_ENV_FILE=$env_file"
} >>"$env_file"

files=(-f "$deploy/docker-compose.yml" -f "$deploy/tiers/full.yml" -f "$deploy/local.yml")
[ -f "$deploy/test/ui-e2e.yml" ] && files+=(-f "$deploy/test/ui-e2e.yml")
dc() { docker compose -p "$project" --project-directory "$deploy" --env-file "$env_file" "${files[@]}" "$@"; }

step=""
cleanup() {
  local code=$?
  if (( code != 0 )); then echo "---- 失败于：$step ----" >&2; fi
  dc ps -a >"$report/compose-ps.txt" 2>&1 || true
  for s in lobe shell core litellm; do dc logs --no-color --tail 300 "$s" >"$report/log-$s.txt" 2>&1 || true; done
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$env_file"
  exit "$code"
}
trap cleanup EXIT

step="构建并启动"
dc up -d --build --quiet-pull postgres redis rustfs rustfs-init litellm core lobe shell fake-llm

step="等待界面就绪"
for i in $(seq 1 120); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "$base/" || true)"
  if [ "$code" = 200 ] || [ "$code" = 302 ] || [ "$code" = 307 ]; then echo "界面就绪（${i}×5s，HTTP $code）"; break; fi
  if [ "$i" = 120 ]; then echo "界面 10 分钟没就绪（最后 HTTP $code）" >&2; exit 1; fi
  sleep 5
done

step="注册测试用户"
for i in $(seq 1 12); do
  code="$(curl -s -o "$report/signup.json" -w '%{http_code}' -X POST "$base/api/auth/sign-up/email" \
    -H 'content-type: application/json' -H "origin: $base" \
    --data "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"测试\"}" || true)"
  if [ "$code" = 200 ]; then echo "已注册"; break; fi
  if [ "$i" = 12 ]; then echo "注册失败 HTTP $code" >&2; head -c 500 "$report/signup.json" >&2 || true; exit 1; fi
  sleep 5
done
# #245：所有者按 LobeHub 用户 id 识别——取刚注册用户的 id，写进 SHELL_OWNER_USER_ID 并重建 shell
owner_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("user",{}).get("id",""))' "$report/signup.json")"
rm -f "$report/signup.json"
if [ -z "$owner_id" ]; then echo "注册响应里没有 user.id" >&2; exit 1; fi
echo "SHELL_OWNER_USER_ID=$owner_id" >>"$env_file"
step="用所有者 id 重建 shell"
dc up -d --no-deps shell
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/aroomo/healthz" || true)"
  if [ "$code" = 200 ]; then echo "shell 已重建（${i}×2s）"; break; fi
  if [ "$i" = 60 ]; then echo "shell 重建后 2 分钟没就绪（最后 HTTP $code）" >&2; exit 1; fi
  sleep 2
done

step="Playwright 冒烟"
pw_dir="$(mktemp -d)"
(cd "$pw_dir" && npm init -y >/dev/null && npm i --no-audit --no-fund playwright@1.56.1 >/dev/null && npx playwright install --with-deps chromium >/dev/null)
PW_DIR="$pw_dir" E2E_BASE="$base" E2E_EMAIL="$email" E2E_PASSWORD="$password" E2E_REPORT_DIR="$report" \
  node "$root/shell/e2e/ui-smoke.mjs"
