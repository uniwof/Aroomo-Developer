#!/usr/bin/env bash
# shellcheck disable=SC2015
# create-app-db-role.sh 的本机测试（staging 实跑发现的两个问题）：用临时仓库副本 + 假的 docker / psql，不需要真数据库。
#   scripts/test-create-app-db-role.sh
# 1. postgres 容器没设 POSTGRES_USER 时 psql 要用 postgres 登录（以前是空的 → 用 root 连 → 失败）。
# 2. --staging（或 AROOMO_STAGING=1）要和 deploy/staging/deploy-staging.sh 用同一组 compose 参数（-p aroomo-staging + staging 覆盖文件）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# 临时仓库：只要脚本本身、compose.sh、select-tier.sh 和一个 .env
repo="$work/repo"
mkdir -p "$repo/scripts" "$repo/deploy/staging" "$repo/deploy/tiers"
cp "$here/create-app-db-role.sh" "$here/compose.sh" "$here/select-tier.sh" "$repo/scripts/"
touch "$repo/deploy/docker-compose.yml" "$repo/deploy/tiers/standard.yml" "$repo/deploy/staging/compose.staging.yml"

# 假 docker：记录参数；遇到 `exec -T postgres <命令…>` 就在「没有 POSTGRES_USER 的容器环境」里真跑那条命令（psql 是假的）
bin="$work/bin"; mkdir -p "$bin"
cat >"$bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"${T_CALLS:?}"
args=("$@")
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = exec ] && [ "${args[$((i+1))]}" = -T ] && [ "${args[$((i+2))]}" = postgres ]; then
    exec env -u POSTGRES_USER "${args[@]:$((i+3))}"
  fi
done
exit 0
STUB
cat >"$bin/psql" <<'STUB'
#!/usr/bin/env bash
# 假 psql：记下 -U 的值；读完 stdin（不存，口令不落盘）
user=""
while [ $# -gt 0 ]; do case "$1" in -U) user="$2"; shift 2 ;; *) shift ;; esac; done
echo "psql-user=[$user]" >>"${T_CALLS:?}"
cat >/dev/null
[ -n "$user" ] || { echo 'psql: role "root" does not exist' >&2; exit 2; }
exit 0
STUB
chmod +x "$bin/docker" "$bin/psql"
export PATH="$bin:$PATH" AROOMO_TIER=standard
calls="$work/calls"; export T_CALLS="$calls"

run() { # run <说明> [参数…]：每次用新的 .env
  local name="$1"; shift
  printf 'CORE_DATABASE_URL=postgres://x@postgres/aroomo_core\n' >"$repo/deploy/.env"
  : >"$calls"
  local rc=0
  OUT="$("$repo/scripts/create-app-db-role.sh" "$@" 2>&1)" || rc=$?
  RC=$rc
  if [ "$rc" = 0 ]; then ok "$name 退出码 0"; else bad "$name 退出码 $rc"; echo "$OUT" | sed 's/^/     /'; fi
}

# --- 生产（默认）：经 compose.sh，psql 用 postgres 登录
run "默认（生产）"
grep -qx 'psql-user=\[postgres\]' "$calls" && ok "没设 POSTGRES_USER 时 psql 用 postgres" || bad "psql 用户不对：$(grep psql-user "$calls" || echo 没调用)"
grep -q -- "--project-directory $repo/scripts/../deploy -f $repo/scripts/../deploy/docker-compose.yml -f $repo/scripts/../deploy/tiers/standard.yml exec -T postgres" "$calls" \
  && ok "默认走 compose.sh 那组文件" || bad "默认 compose 参数不对：$(cat "$calls")"
grep -q -- '-p aroomo-staging' "$calls" && bad "默认不该带 staging 项目名" || ok "默认不带 staging 项目名"
grep -q '^CORE_DB_APP_ROLE=aroomo_core_app$' "$repo/deploy/.env" && ok ".env 写了 CORE_DB_APP_ROLE" || bad ".env 没写 CORE_DB_APP_ROLE"
[ "$(stat -c %a "$repo/deploy/.env")" = 600 ] && ok ".env 权限 600" || bad ".env 权限不对"
echo "$OUT" | grep -q 'scripts/compose.sh up -d --force-recreate core' && ok "默认提示生产的重建命令" || bad "默认下一步提示不对：$OUT"
grep -q "$(grep '^CORE_APP_DB_PASSWORD=' "$repo/deploy/.env" | cut -d= -f2)" <<<"$OUT$(cat "$calls")" && bad "口令出现在输出或 docker 参数里" || ok "口令不在输出和 docker 参数里"

# --- staging：和 deploy-staging.sh 同一组 compose 参数
stg_args="compose -p aroomo-staging --project-directory $repo/deploy --env-file $repo/deploy/.env -f $repo/deploy/docker-compose.yml -f $repo/deploy/staging/compose.staging.yml"
for how in flag env; do
  if [ "$how" = flag ]; then run "--staging" --staging; else AROOMO_STAGING=1 run "AROOMO_STAGING=1"; fi
  grep -q -- "^$stg_args exec -T postgres" "$calls" && ok "staging（$how）用 -p aroomo-staging + staging 覆盖文件" || bad "staging（$how）compose 参数不对：$(cat "$calls")"
  grep -qx 'psql-user=\[postgres\]' "$calls" && ok "staging（$how）psql 用 postgres" || bad "staging（$how）psql 用户不对"
  echo "$OUT" | grep -q -- "-p aroomo-staging .*compose.staging.yml up -d --no-deps --force-recreate core" && ok "staging（$how）提示 staging 的重建命令" || bad "staging（$how）下一步提示不对：$OUT"
done

# 部署脚本里的 compose 参数没变（变了就要同步改 create-app-db-role.sh）
grep -q 'docker compose -p "$PROJECT" --project-directory "$STAGING_ROOT/deploy"' "$here/../deploy/staging/deploy-staging.sh" \
  && grep -q -- '-f "$STAGING_ROOT/deploy/docker-compose.yml" -f "$STAGING_ROOT/deploy/staging/compose.staging.yml"' "$here/../deploy/staging/deploy-staging.sh" \
  && grep -q '^PROJECT=aroomo-staging$' "$here/../deploy/staging/deploy-staging.sh" \
  && ok "deploy-staging.sh 的 compose 参数和这里对得上" || bad "deploy-staging.sh 的 compose 参数变了，同步改 create-app-db-role.sh"

# 未知参数要拒绝，不能悄悄当生产跑
printf 'x=1\n' >"$repo/deploy/.env"; : >"$calls"
rc=0; "$repo/scripts/create-app-db-role.sh" --stagin >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] && [ ! -s "$calls" ] && ok "未知参数拒绝、没碰数据库" || bad "未知参数没被拒绝（退出码 $rc）"

# RLS.md 的命令同步（第 3、4 步）
doc="$here/../docs/ops/RLS.md"
grep -q -- '-U "${POSTGRES_USER:-postgres}"' "$doc" && ! grep -q -- '-U "$POSTGRES_USER"' "$doc" && ok "RLS.md 核对命令默认 postgres" || bad "RLS.md 核对命令的 -U 没改"
grep -q 'create-app-db-role.sh --staging' "$doc" && grep -q -- '-p aroomo-staging' "$doc" && ok "RLS.md 写了 staging 的跑法" || bad "RLS.md 没写 staging 的跑法"

[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
