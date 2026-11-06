#!/usr/bin/env bash
# 生产前检查 + 部署前备份（工单 #229 / D253）。任何一项不过就退出码 1，release-tag.sh 因此拒绝部署。
#
#   scripts/release-precheck.sh               三项检查 + 部署前加密备份到 R2 并核对
#   scripts/release-precheck.sh --no-backup   只做检查（演练用，不备份）
#   scripts/release-precheck.sh --paid-launch 收费上线前：另外要求检查 7 的借用目录为空
#
# 检查 1  只查开了 RLS 的表（清单 scripts/lib/rls-tables.txt：members、public_memory、public_memory_versions、
#         library_items、vault_secrets、inbox_items、provider_keys）。清单里的表不能有空串 user_id（RLS 迁移会加
#         CHECK (user_id <> '')，空串行会让迁移失败，或在策略里被当作「未设置」）；有就列出表名 + 行数并失败。
#         NULL 同样算失败：CHECK 对 NULL 放行，而 RLS 下 user_id = x 对 NULL 行永远不成立，行还在但谁都看不见。
#         只有 BACKFILL_NULL 里的表（迁移 0023 inbox_items、0024 provider_keys 会先把 NULL 改成 'owner'）可以有 NULL。
#         清单里的表不存在、查询出错，都算失败（失败即关闭）；唯一例外：表不存在、且目标版本 core/migrations/ 里
#         还没执行（不在 core_schema_migrations）的迁移会 CREATE TABLE 它——打一行「将由待执行迁移 NNNN 新建」放行
#         （新表是空的，没有要查的行；比如 v0.2.0 首次带上 0025–0030）。迁移目录或迁移记录读不出来就不放行。
#         RELEASE_MIGRATIONS_DIR 可改迁移目录（默认脚本旁边的 ../core/migrations，release-tag.sh 会一起取出）；清单外带 user_id 的表（比如允许系统事件 NULL 的审计表）
#         只打一行信息，不拦发布。
# 检查 2  『owner』与 NULL 会不会撞唯一索引：迁移 0023/0024 把 NULL 改成 'owner'。按迁移后的表达式
#         （coalesce(user_id,'owner') + 各索引原有列和条件）试算重复，撞了就失败。表名 + 重复组数，不打印任何数据内容。
# 检查 3  逐表行数可读（scripts/lib/table-counts.sql），结果存 $RELEASE_ROOT/.release/precheck-<时间>.counts.tsv，
#         部署后可对照。
# 检查 4  生产 deploy/.env 里 Shell 所有者已设置，按 SHELL_AUTH 分两种（没写 SHELL_AUTH 时按 docker-compose 默认 core-session）：
#           core-session（PR #259 起默认）：SHELL_OWNER_EMAIL 恰好一行、非空、像邮箱（含 @）；
#           lobe-session（回退旧登录）：SHELL_OWNER_USER_ID 恰好一行且非空（#252，此时 SHELL_OWNER_EMAIL 无作用）。
#         只数匹配行，不打印值。SHELL_AUTH 是别的值（含 off）一律失败。
# 检查 5  MCP 专用网段（.env 的 MCP_NET_SUBNET，默认 172.29.77.0/29）没有被主机上别的 docker 网络或路由占用
#         （docker network inspect + ip route，只读）。冲突则失败，提示改 MCP_NET_SUBNET 与 CORE_MCP_IP。
#         Aroomo 自己的 aroomo_aroomo-mcp 网络（上次部署建的）不算冲突。
# 检查 6  设了 CORE_OWNER_ACCOUNT_ID（方案 A）时：必须是 UUID、SHELL_AUTH=core-session，且 users 表里这个 id 的邮箱
#         就是 SHELL_OWNER_EMAIL（不分大小写）、角色 admin、状态 active。没设则通过。不打印邮箱和 id。
# 检查 7  core/src/third_party/ekko 收费上线前必须为空（借自 Ekko Studio，BSL 1.1 只许非商用；所有者 2026-11-05 13:00）。
#         平时只打一行信息提醒（自用发布可以带着）；加 --paid-launch 时非空即失败。
# 备份    调用现有备份流程（scripts/backup.sh，主密钥公钥加密，异地 R2）做一次，核对：状态 ok、已上传异地、
#         大小 > 0、备份名在 R2 远端的列表里完全相等（backup snapshots --from offsite，不是本地目录，不做子串匹配）。
#         备份本身带两道远端核对：上传后 backup.sh 比对 R2 上文件大小与本地 size_bytes（不等就失败）；这里还强制
#         BACKUP_CHECK=always，从 R2 重新下载核对 SHA-256 和 age 文件头，结果里必须 checked:true。
#         这台机器没有主密钥，能不能解开只靠恢复演练验证。
#
# 只读：数据库连接带 default_transaction_read_only=on，只有 SELECT。不改数据、不碰数据卷、不打印 .env。
#
# 环境变量（测试用，生产不用设）：
#   RELEASE_ROOT（默认脚本所在仓库根）RELEASE_TIER（standard）
#   RELEASE_PSQL        从 stdin 读一条 SQL、输出「制表符分隔、无表头」结果的命令；默认走 compose exec postgres psql
#   RELEASE_BACKUP_CMD  立即备份命令（stdout 最后一行为 JSON）；默认 compose --profile backup run --rm -T -e BACKUP_CHECK=always backup now
#   RELEASE_SNAPSHOTS_CMD 列出 R2 远端备份的命令（每行一个文件名）；默认 compose --profile backup run --rm -T backup snapshots --from offsite
#   RELEASE_DOCKER_NETS_CMD 列出 docker 网络的命令（每行「名称 ID 网段…」）；默认 docker network inspect 全部网络
#   RELEASE_IP_ROUTE_CMD  列出主机路由的命令；默认 ip -4 route show
#   RELEASE_MCP_NET_NAME  Aroomo 自己的 MCP 网络名（默认 aroomo_aroomo-mcp）
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${RELEASE_ROOT:-$(cd "$here/.." && pwd)}"
TIER="${RELEASE_TIER:-standard}"
DB="${RELEASE_PRECHECK_DB:-aroomo_core}"
state="$ROOT/.release"
mkdir -p "$state"

do_backup=1
paid_launch=0
for a in "$@"; do
  case "$a" in
    --no-backup) do_backup=0 ;;
    --paid-launch) paid_launch=1 ;;
    *) echo "用法：release-precheck.sh [--no-backup] [--paid-launch]" >&2; exit 64 ;;
  esac
done

failures=0
say() { printf '%s\n' "$*"; }
pass() { say "通过  $*"; }
fail() { say "失败  $*"; failures=$((failures + 1)); }

compose() { AROOMO_TIER="$TIER" "$ROOT/scripts/compose.sh" "$@"; }

# 一条 SQL（stdin）→ 制表符分隔的行
q() {
  if [ -n "${RELEASE_PSQL:-}" ]; then
    # shellcheck disable=SC2086  # 命令由调用方给出，允许带参数
    $RELEASE_PSQL
  else
    compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
      psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -U postgres -d "$DB"
  fi
}
sql() { printf '%s\n' "$1" | q; }

# 迁移会先把 NULL 回填成 'owner' 的表（0023 inbox_items、0024 provider_keys）
BACKFILL_NULL=(inbox_items provider_keys)
is_backfill() { local x; for x in "${BACKFILL_NULL[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
# 开了 RLS 的表清单：从脚本自己旁边的 lib/ 读（第一次部署时生产目录里还没有 scripts/lib/）
rls_file="$here/lib/rls-tables.txt"

ident_ok() { [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]]; }
# 0 = 存在；1 = 不存在；2 = 查询出错
table_exists() { local r; r="$(sql "select to_regclass('public.$1') is not null")" || return 2; [ "$r" = t ]; }

say "== 生产前检查 $(date '+%F %T %Z') =="

if ! reach="$(sql 'select 1' 2>&1)" || [ "$reach" != 1 ]; then
  fail "连不上数据库 $DB（只读查询失败）"
  say "共 $failures 项失败，拒绝部署"
  exit 1
fi
pass "数据库可连接（只读）"

# ---------------------------------------------------------------------------
# 检查 1：开了 RLS 的表里的空串 / NULL user_id
if ! tables="$(sql "select c.table_name from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'user_id' and c.data_type in ('text', 'character varying')
  order by 1")"; then
  fail "检查 1 查询带 user_id 的表时出错"
  tables=""
fi
rls_tables=()
if [ -f "$rls_file" ]; then
  while IFS= read -r t; do
    t="${t%%#*}"; t="${t//[[:space:]]/}"
    [ -n "$t" ] && rls_tables+=("$t")
  done <"$rls_file"
fi
[ "${#rls_tables[@]}" -gt 0 ] || fail "检查 1 读不到 RLS 表清单（$rls_file 不存在或为空）"
# 本次发布还没执行的迁移：目标版本的 core/migrations/ 里有、core_schema_migrations 里没有的文件。
# release-tag.sh 把目标版本的 core/migrations/ 和 scripts/ 一起取到临时目录，所以默认就在脚本旁边的 ../core/migrations。
# 迁移目录或迁移记录读不出来 → 不算出任何待执行迁移（失败即关闭：不存在的表照旧失败）。
mig_dir="${RELEASE_MIGRATIONS_DIR:-$here/../core/migrations}"
pending_migs=()
pending_note=""
if [ ! -d "$mig_dir" ]; then
  pending_note="；找不到目标版本的迁移目录，不按待执行迁移放行"
elif ! applied_migs="$(sql "select version from core_schema_migrations")"; then
  pending_note="；读不出迁移记录 core_schema_migrations，不按待执行迁移放行"
else
  for f in "$mig_dir"/*.sql; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"
    [[ "$b" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || continue   # 与 core/src/db/migrate.ts 的 FILE_RE 一致
    grep -qxF "$b" <<<"$applied_migs" || pending_migs+=("$b")
  done
  [ "${#pending_migs[@]}" -gt 0 ] || pending_note="；没有待执行的迁移会新建它"
fi
# created_by_pending <表> → 打印新建它的待执行迁移文件名（去掉 -- 注释行后找 CREATE TABLE）
created_by_pending() {
  local t="$1" f re
  re="^[[:space:]]*create[[:space:]]+table[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?(public\.)?\"?$t\"?([[:space:](]|$)"
  for f in "${pending_migs[@]}"; do
    if grep -v '^[[:space:]]*--' "$mig_dir/$f" | grep -qiE "$re"; then printf '%s' "$f"; return 0; fi
  done
  return 1
}
rls_pending=""
bad_tables=""
null_bad=""
nullable_info=""
rls_checked=0
for t in "${rls_tables[@]}"; do
  ident_ok "$t" || { fail "检查 1 清单里表名不合法：$t"; continue; }
  if ! grep -qx "$t" <<<"$tables"; then
    # 表还不存在、且本次发布的待执行迁移会新建它（空表，没有要查的行）→ 放行；其余情况照旧失败
    te=0; table_exists "$t" || te=$?
    if [ "$te" = 1 ] && mig="$(created_by_pending "$t")"; then
      rls_pending="$rls_pending $t(${mig%%_*})"; continue
    fi
    fail "检查 1 RLS 表 $t 不存在或没有文本列 user_id（schema 不对或连错了库？${pending_note}）"; continue
  fi
  n="$(sql "select count(*) from public.\"$t\" where user_id = ''")" || { fail "检查 1 查询 $t 空串时出错"; continue; }
  nulls="$(sql "select count(*) from public.\"$t\" where user_id is null")" || { fail "检查 1 查询 $t NULL 时出错"; continue; }
  owners="$(sql "select count(*) from public.\"$t\" where user_id = 'owner'")" || { fail "检查 1 查询 $t owner 时出错"; continue; }
  rls_checked=$((rls_checked + 1))
  [ "$n" = 0 ] || bad_tables="$bad_tables $t=$n"
  if [ "$nulls" != 0 ]; then
    if is_backfill "$t"; then nullable_info="$nullable_info $t(NULL=$nulls,owner=$owners)"
    else null_bad="$null_bad $t=$nulls"; fi
  fi
done
others=""
while IFS= read -r t; do
  [ -n "$t" ] || continue
  grep -qx "$t" < <(printf '%s\n' "${rls_tables[@]}") || others="$others $t"
done <<<"$tables"
if [ -n "$bad_tables" ]; then
  fail "检查 1 空串 user_id：${bad_tables# }（表=行数；先改成 'owner' 或真实账号再部署）"
elif [ "$rls_checked" -gt 0 ]; then
  pass "检查 1 空串 user_id：检查了 $rls_checked 张开了 RLS 的表，没有空串"
fi
if [ -n "$null_bad" ]; then
  fail "检查 1 NULL user_id：${null_bad# }（表=行数；这些表的迁移不会回填 NULL，加了 RLS 后这些行谁都看不见；先改成 'owner' 或真实账号）"
elif [ "$rls_checked" -gt 0 ]; then
  pass "检查 1 NULL user_id：除迁移会回填的表外没有 NULL"
fi
[ -z "$rls_pending" ] || say "信息  检查 1 这些 RLS 表还不存在，将由本次待执行的迁移新建（空表，不查）：${rls_pending# }"
[ -z "$nullable_info" ] || say "信息  user_id 为 NULL 的行（迁移 0023/0024 会改成 'owner'）：${nullable_info# }"
[ -z "$others" ] || say "信息  清单外带 user_id 的表（没开 RLS，不检查）：${others# }"

# ---------------------------------------------------------------------------
# 检查 2：迁移后唯一索引试算。每行：表|其他键列|条件
# 注意：不能写成 printf | grep -q —— pipefail 下 grep 提前退出会让 printf 吃 SIGPIPE，整条管道判失败
has_user_id() { grep -qx "$1" <<<"$tables"; }

trial_rows=(
  "inbox_items|kind, related_type, related_id|status = 'open' AND related_type IS NOT NULL"  # 0015 + 0023
  "members|lower(name)|deleted_at IS NULL"                                                    # 0009
  "vault_secrets|lower(name)|deleted_at IS NULL"                                              # 0012
  "library_items|url|url IS NOT NULL"                                                         # 0017
  "public_memory|topic|true"                                                                  # 0011
  "executors|client_id|true"                                                                  # 0013
)
dups=""
trial_done=0
for row in "${trial_rows[@]}"; do
  IFS='|' read -r t cols where <<<"$row"
  te=0; table_exists "$t" || te=$?
  if [ "$te" = 2 ]; then fail "检查 2 查询表 $t 是否存在时出错"; continue; fi
  if [ "$te" = 1 ]; then say "信息  表 $t 还不存在，跳过试算"; continue; fi
  if has_user_id "$t"; then key="coalesce(user_id, 'owner')"; else key="'owner'"; fi
  d="$(sql "select count(*) from (select 1 from public.$t where $where group by $key, $cols having count(*) > 1) x")" \
    || { fail "检查 2 试算 $t 时查询出错"; continue; }
  trial_done=$((trial_done + 1))
  if [ "$d" != 0 ]; then dups="$dups $t=${d}组"; fi
done
if [ -n "$dups" ]; then
  fail "检查 2 『owner』与 NULL 撞唯一索引：${dups# }（把 NULL 改成 'owner' 后这些组会重复；先合并或删掉重复项）"
else
  pass "检查 2 唯一索引试算：$trial_done 个索引按迁移后的表达式试算，没有重复"
fi

# ---------------------------------------------------------------------------
# 检查 3：逐表行数可读，存一份对照
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
counts_file="$state/precheck-$stamp.counts.tsv"
if counts="$(q <"$here/lib/table-counts.sql" 2>/dev/null)" && [ -n "$counts" ]; then
  printf '%s\n' "$counts" >"$counts_file"
  pass "检查 3 逐表行数可读：$(printf '%s\n' "$counts" | grep -c .) 张表，已存 .release/$(basename "$counts_file")"
else
  fail "检查 3 逐表行数读不出来（scripts/lib/table-counts.sql 执行失败）"
fi

# ---------------------------------------------------------------------------
# 检查 4：Shell 所有者已设置（core-session 看 SHELL_OWNER_EMAIL，lobe-session 看 SHELL_OWNER_USER_ID；只数匹配行，绝不打印值）
env_file="$ROOT/deploy/.env"
env_val() { # env_val <键>：取 .env 里最后一次出现的值，去掉首尾空白和成对引号；不输出到日志
  local v
  v="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}
shell_auth=""
[ ! -f "$env_file" ] || shell_auth="$(env_val SHELL_AUTH)"
shell_auth="${shell_auth:-core-session}" # 与 deploy/docker-compose.yml 的 ${SHELL_AUTH:-core-session} 一致
case "$shell_auth" in
  core-session) owner_key=SHELL_OWNER_EMAIL; owner_re='^[[:space:]]*SHELL_OWNER_EMAIL=["'"'"']?[^[:space:]"'"'"'@]+@[^[:space:]"'"'"'@]+' ;;
  lobe-session) owner_key=SHELL_OWNER_USER_ID; owner_re='^[[:space:]]*SHELL_OWNER_USER_ID=[^[:space:]"'"'"']+' ;;
  *) owner_key="" ;;
esac
owner_lines=0
[ ! -f "$env_file" ] || [ -z "$owner_key" ] || owner_lines="$(grep -cE "$owner_re" "$env_file" || true)"
key_lines=0
[ ! -f "$env_file" ] || [ -z "$owner_key" ] || key_lines="$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$owner_key=" "$env_file" || true)"
if [ ! -f "$env_file" ]; then
  fail "检查 4 找不到 deploy/.env"
elif [ -z "$owner_key" ]; then
  fail "检查 4 deploy/.env 里 SHELL_AUTH 只能是 core-session 或 lobe-session（生产不允许 off），现在是别的值（不显示）"
elif [ "$key_lines" -gt 1 ]; then
  fail "检查 4 deploy/.env 里 $owner_key 出现了 $key_lines 次，只能有一行（SHELL_AUTH=$shell_auth）"
elif [ "$owner_lines" = 1 ]; then
  pass "检查 4 SHELL_AUTH=$shell_auth，deploy/.env 里 $owner_key 已设置（不显示值）"
elif [ "$shell_auth" = core-session ]; then
  fail "检查 4 SHELL_AUTH=core-session，deploy/.env 里 SHELL_OWNER_EMAIL 没有设置、为空或不像邮箱（所有者的 Core 账号邮箱，留空则所有者也被 403；请主会话在服务器上补上）"
else
  fail "检查 4 SHELL_AUTH=lobe-session，deploy/.env 里 SHELL_OWNER_USER_ID 没有设置或为空（所有者的 LobeHub 用户 id，#252 起旧登录只认它，留空则所有者也被 403；请主会话在服务器上补上）"
fi

# ---------------------------------------------------------------------------
# 检查 6（方案 A，负责人必改 4）：设了 CORE_OWNER_ACCOUNT_ID 时，它和 Shell 的 SHELL_OWNER_EMAIL 必须是同一个账号，
# 且这个账号是启用的管理员（Core 启动检查同样要求）。没设 = Core 不映射，通过。只读一条 count，不打印邮箱和 id。
core_owner_id=""
[ ! -f "$env_file" ] || core_owner_id="$(env_val CORE_OWNER_ACCOUNT_ID | tr '[:upper:]' '[:lower:]')"
if [ -z "$core_owner_id" ]; then
  pass "检查 6 没设 CORE_OWNER_ACCOUNT_ID：Core 不把所有者账号映射到所有者数据，无需比对"
elif ! [[ "$core_owner_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  fail "检查 6 deploy/.env 里 CORE_OWNER_ACCOUNT_ID 不是 UUID（Core 会拒绝启动）"
elif [ "$shell_auth" != core-session ]; then
  fail "检查 6 设了 CORE_OWNER_ACCOUNT_ID，但 SHELL_AUTH 不是 core-session：没法和 Shell 的所有者账号比对（去掉它，或改回 core-session）"
else
  owner_email="$(env_val SHELL_OWNER_EMAIL | tr '[:upper:]' '[:lower:]')"
  if ! [[ "$owner_email" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+$ ]]; then
    fail "检查 6 SHELL_OWNER_EMAIL 含邮箱以外的字符（或为空），不拼进 SQL，无法比对"
  elif ! n="$(sql "select count(*) from users where id = '$core_owner_id'::uuid and lower(email) = '$owner_email' and role = 'admin' and status = 'active'")"; then
    fail "检查 6 读 users 表出错，无法确认 SHELL_OWNER_EMAIL 与 CORE_OWNER_ACCOUNT_ID 是同一个账号"
  elif [ "$n" = 1 ]; then
    pass "检查 6 SHELL_OWNER_EMAIL 与 CORE_OWNER_ACCOUNT_ID 是同一个账号，且是启用的管理员（不显示值）"
  else
    fail "检查 6 SHELL_OWNER_EMAIL 与 CORE_OWNER_ACCOUNT_ID 不是同一个账号，或这个账号不是启用的管理员（不显示值；请主会话在服务器上核对）"
  fi
fi

# ---------------------------------------------------------------------------
# 检查 5：MCP 专用网段有没有被主机上别的网络占用
ip2int() { local a b c d; IFS=. read -r a b c d <<<"$1"; echo $(( (a << 24) | (b << 16) | (c << 8) | d )); }
cidr_ok() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; }
# cidr_range <a.b.c.d[/n]> → 「起 止」整数
cidr_range() {
  local ip="${1%/*}" n=32 base mask
  [[ "$1" == */* ]] && n="${1#*/}"
  base="$(ip2int "$ip")"
  if [ "$n" = 0 ]; then mask=0; else mask=$(( (0xFFFFFFFF << (32 - n)) & 0xFFFFFFFF )); fi
  echo "$(( base & mask )) $(( (base & mask) | (~mask & 0xFFFFFFFF) ))"
}
overlaps() { local a1 a2 b1 b2; read -r a1 a2 <<<"$(cidr_range "$1")"; read -r b1 b2 <<<"$(cidr_range "$2")"; [ "$a1" -le "$b2" ] && [ "$b1" -le "$a2" ]; }
mcp_subnet="172.29.77.0/29"
[ ! -f "$env_file" ] || { v="$(env_val MCP_NET_SUBNET)"; [ -z "$v" ] || mcp_subnet="$v"; }
own_net="${RELEASE_MCP_NET_NAME:-aroomo_aroomo-mcp}"
list_nets() {
  if [ -n "${RELEASE_DOCKER_NETS_CMD:-}" ]; then $RELEASE_DOCKER_NETS_CMD; return; fi
  local ids; ids="$(docker network ls -q)" || return 1
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  docker network inspect --format '{{.Name}} {{.Id}}{{range .IPAM.Config}} {{.Subnet}}{{end}}' $ids
}
list_routes() { if [ -n "${RELEASE_IP_ROUTE_CMD:-}" ]; then $RELEASE_IP_ROUTE_CMD; else ip -4 route show; fi; }
if ! cidr_ok "$mcp_subnet"; then
  fail "检查 5 MCP_NET_SUBNET 不是有效的 IPv4 网段：$mcp_subnet"
elif ! nets="$(list_nets 2>/dev/null)"; then
  fail "检查 5 读不出 docker 网络列表（docker network inspect 失败），无法确认网段 $mcp_subnet 没被占用"
elif ! routes="$(list_routes 2>/dev/null)"; then
  fail "检查 5 读不出主机路由（ip route 失败），无法确认网段 $mcp_subnet 没被占用"
else
  clash=""; own_bridge=""
  while read -r name id rest; do
    [ -n "${name:-}" ] || continue
    if [ "$name" = "$own_net" ]; then own_bridge="br-${id:0:12}"; continue; fi
    for sn in $rest; do
      cidr_ok "$sn" || continue   # 跳过 IPv6
      overlaps "$sn" "$mcp_subnet" && clash="$clash docker网络:$name($sn)"
    done
  done <<<"$nets"
  while read -r dst rest; do
    [ -n "${dst:-}" ] || continue
    [ "$dst" = default ] && continue
    cidr_ok "$dst" || continue
    dev="$(printf '%s\n' "$rest" | sed -n 's/.*\bdev \([^ ]*\).*/\1/p')"
    [ -n "$own_bridge" ] && [ "$dev" = "$own_bridge" ] && continue
    overlaps "$dst" "$mcp_subnet" && clash="$clash 路由:$dst${dev:+(dev $dev)}"
  done <<<"$routes"
  if [ -n "$clash" ]; then
    fail "检查 5 MCP 网段 $mcp_subnet 与主机上已有网络冲突：${clash# }。在 deploy/.env 里把 MCP_NET_SUBNET 改成没被占用的 /29，并把 CORE_MCP_IP 改成新网段里的地址，再部署"
  else
    pass "检查 5 MCP 网段 $mcp_subnet 没有被别的 docker 网络或路由占用"
  fi
fi

# ---------------------------------------------------------------------------
# 检查 7：third_party/ekko must be empty before paid launch
borrowed_dir="$ROOT/core/src/third_party/ekko"
borrowed_n=0
if [ -d "$borrowed_dir" ]; then borrowed_n="$(find "$borrowed_dir" -type f | wc -l | tr -d ' ')"; fi
if [ "$borrowed_n" = 0 ]; then
  pass "检查 7 core/src/third_party/ekko 为空，没有借用代码"
elif [ "$paid_launch" = 1 ]; then
  fail "检查 7 core/src/third_party/ekko 还有 $borrowed_n 个借用文件（Ekko Studio，BSL 1.1 只许非商用）：收费上线前必须按 BORROWED.md 剥离清空"
else
  say "信息  检查 7 core/src/third_party/ekko 有 $borrowed_n 个借用文件（BSL 1.1）：自用发布可以；收费上线前必须清空（--paid-launch 会拦）"
fi

# ---------------------------------------------------------------------------
# 部署前备份
if [ "$do_backup" = 0 ]; then
  say "信息  --no-backup：跳过部署前备份"
elif [ "$failures" != 0 ]; then
  say "信息  前面的检查已失败，不做备份"
else
  say "… 部署前备份（加密 → R2）"
  bk_err="$(mktemp)"; trap 'rm -f "$bk_err"' EXIT
  backup_cmd="${RELEASE_BACKUP_CMD:-}"
  snaps_cmd="${RELEASE_SNAPSHOTS_CMD:-}"
  run_backup() { if [ -n "$backup_cmd" ]; then $backup_cmd; else compose --profile backup run --rm -T -e BACKUP_CHECK=always backup now; fi; }
  run_snaps() { if [ -n "$snaps_cmd" ]; then $snaps_cmd; else compose --profile backup run --rm -T backup snapshots --from offsite; fi; }
  rc=0
  out="$(run_backup 2>"$bk_err")" || rc=$?
  if [ "$rc" != 0 ]; then
    fail "部署前备份失败（退出码 $rc）：$(tail -n 3 "$bk_err" | tr '\n' ' ')"
  else
    last="$(printf '%s\n' "$out" | tail -n 1)"
    snap="$(printf '%s' "$last" | grep -o '"snapshot_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    size="$(printf '%s' "$last" | grep -o '"size_bytes":[0-9]*' | head -1 | cut -d: -f2 || true)"
    if ! grep -q '"status":"ok"' <<<"$last"; then
      fail "部署前备份：结果不是 ok（${last:0:120}）"
    elif ! grep -q '"offsite":true' <<<"$last"; then
      fail "部署前备份：没有上传到异地 R2（offsite 不是 true），不算数"
    elif ! grep -q '"checked":true' <<<"$last"; then
      fail "部署前备份：没有从 R2 重新下载核对（checked 不是 true），不算数"
    elif [ -z "$snap" ] || [ -z "$size" ] || [ "$size" -le 0 ]; then
      fail "部署前备份：结果里没有备份名或大小为 0"
    else
      listing="$(run_snaps 2>/dev/null || true)"
      if grep -qxF "$snap.tar.zst.age" <<<"$listing"; then
        pass "部署前备份：$snap（$size 字节）已在 R2：上传后大小一致、重新下载校验通过、R2 列表里能看到"
        printf '%s %s\n' "$stamp" "$snap" >"$state/precheck.ok"
      else
        fail "部署前备份：$snap 没有出现在 R2 的备份列表里"
      fi
    fi
  fi
fi

if [ "$failures" != 0 ]; then
  say "共 $failures 项失败，拒绝部署"
  exit 1
fi
say "全部通过"
