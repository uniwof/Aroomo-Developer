#!/usr/bin/env bash
# D213 第 13 项 / 负责人阶段 3 硬条件：把 aroomo_core_app 变成独立可登录的应用角色，并把口令写进 deploy/.env。
#
#   scripts/create-app-db-role.sh            # 生产：在服务器仓库目录（/opt/aroomo）里跑；可重复跑
#   scripts/create-app-db-role.sh --staging  # staging：在 /opt/aroomo-staging 里跑（也可 AROOMO_STAGING=1）
#     staging 和 deploy/staging/deploy-staging.sh 用同一组 compose 参数（-p aroomo-staging + staging 覆盖文件），
#     否则项目名会变成 deploy、找不到 staging 的 postgres（2026-11-06 staging 实跑发现）。
#
# 做的事（幂等）：
#   1. 角色不存在就建；然后一律设成 LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT。
#   2. 收回它在任何角色里的成员身份（尤其是表所有者 aroomo_core），这样会话里 SET ROLE / RESET ROLE 都回不到所有者。
#   3. 口令：.env 里已有 CORE_APP_DB_PASSWORD 就沿用，没有就在本机生成（openssl，64 位十六进制）。口令只经 stdin 进 psql，
#      不出现在命令行、终端输出里；带口令那句之前本会话关掉语句日志，出错也不进数据库日志。
#   4. 先备份 .env（.env.bak.<时间>），再写入 CORE_DB_APP_ROLE=aroomo_core_app、CORE_APP_DB_PASSWORD=…，权限 600。
# 不做的事：不重建 core、不写 CORE_DB_REQUIRE_APP_ROLE（见 docs/ops/RLS.md，按步骤手动打开）。
# 表权限不在这里授：Core 每次启动由表所有者执行 grantAppRole（core/src/db/app-role.ts）。
set -euo pipefail

staging="${AROOMO_STAGING:-0}"
case "${1:-}" in
  "") ;;
  --staging) staging=1 ;;
  *) echo "用法：$0 [--staging]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$here/../deploy/.env"
# staging：和 deploy/staging/deploy-staging.sh 的 dc() 同一组参数（scripts/test-create-app-db-role.sh 核对两边一致）
deploy="$(cd "$here/../deploy" && pwd)"
stg=(-p aroomo-staging --project-directory "$deploy" --env-file "$deploy/.env" -f "$deploy/docker-compose.yml" -f "$deploy/staging/compose.staging.yml")
dc() { if [[ "$staging" == "1" ]]; then docker compose "${stg[@]}" "$@"; else "$here/compose.sh" "$@"; fi; }
role=aroomo_core_app
owner=aroomo_core
db=aroomo_core

[[ -f "$env_file" ]] || { echo "找不到 deploy/.env" >&2; exit 1; }

pw="$(grep -E '^CORE_APP_DB_PASSWORD=' "$env_file" | tail -n 1 | cut -d= -f2- || true)"
if [[ -z "$pw" ]]; then
  pw="$(openssl rand -hex 32)"
  echo "生成了新的应用角色口令（不显示）"
else
  echo "沿用 .env 里已有的应用角色口令"
fi
[[ "$pw" =~ ^[0-9a-f]{64}$ ]] || { echo ".env 里的 CORE_APP_DB_PASSWORD 不是 64 位十六进制，先删掉那一行再跑" >&2; exit 1; }

# shellcheck disable=SC2016 # $POSTGRES_USER 要在容器里展开；compose 没给 postgres 容器设它（只有 POSTGRES_PASSWORD/DB），空了就用镜像默认的 postgres
# 口令只经 stdin：\set 不回显；ON_ERROR_STOP 任何一步失败就整体退出
{
  printf '\\set pw %s\n' "$pw"
  cat <<SQL
SELECT 'CREATE ROLE $role' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') \\gexec
-- D199-1：下一句带口令，出错时 PostgreSQL 默认把整条语句写进日志（docker logs）。本会话关掉语句日志再执行（负责人 #285 必改 2）
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
ALTER ROLE $role LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD :'pw';
-- 收回它在任何角色里的成员身份（旧做法里是 aroomo_core 属于它，方向相反，不受影响）
SELECT format('REVOKE %I FROM %I', r.rolname, '$role')
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
 WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = '$role') \\gexec
GRANT CONNECT ON DATABASE $db TO $role;
-- 自检：不能是任何角色的成员、不拥有任何表、不是超级用户 / BYPASSRLS
DO \$\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = '$role');
  IF n > 0 THEN RAISE EXCEPTION '$role 仍是 % 个角色的成员', n; END IF;
  IF pg_has_role('$role', '$owner', 'MEMBER') THEN RAISE EXCEPTION '$role 能变成表所有者 $owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role' AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION '$role 是超级用户或可绕过 RLS'; END IF;
END \$\$;
SQL
} | dc exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d '"$db"

cp -p "$env_file" "$env_file.bak.$(date +%Y%m%d%H%M%S)"
tmp="$(mktemp "$env_file.XXXXXX")"
grep -vE '^(CORE_DB_APP_ROLE|CORE_APP_DB_PASSWORD)=' "$env_file" > "$tmp" || true
printf 'CORE_DB_APP_ROLE=%s\nCORE_APP_DB_PASSWORD=%s\n' "$role" "$pw" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$env_file"
echo "完成：$role 可登录、不是所有者的成员；.env 已写入 CORE_DB_APP_ROLE 和 CORE_APP_DB_PASSWORD（已备份旧 .env）。"
if [[ "$staging" == "1" ]]; then
  next="docker compose ${stg[*]} up -d --no-deps --force-recreate core"
else
  next="scripts/compose.sh up -d --force-recreate core"
fi
echo "下一步：$next，看日志 appDatabaseUrl=(set) 且没有「拒绝启动」。"
