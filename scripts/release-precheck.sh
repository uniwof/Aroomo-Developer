#!/usr/bin/env bash
# 生产前检查 + 部署前备份（工单 #229 / D253）。任何一项不过就退出码 1，release-tag.sh 因此拒绝部署。
#
#   scripts/release-precheck.sh               三项检查 + 部署前加密备份到 R2 并核对
#   scripts/release-precheck.sh --no-backup   只做检查（演练用，不备份）
#
# 检查 1  只查开了 RLS 的表（清单 scripts/lib/rls-tables.txt：members、public_memory、public_memory_versions、
#         library_items、vault_secrets、inbox_items、provider_keys）。清单里的表不能有空串 user_id（RLS 迁移会加
#         CHECK (user_id <> '')，空串行会让迁移失败，或在策略里被当作「未设置」）；有就列出表名 + 行数并失败。
#         NULL 同样算失败：CHECK 对 NULL 放行，而 RLS 下 user_id = x 对 NULL 行永远不成立，行还在但谁都看不见。
#         只有 BACKFILL_NULL 里的表（迁移 0023 inbox_items、0024 provider_keys 会先把 NULL 改成 'owner'）可以有 NULL。
#         清单里的表不存在、查询出错，都算失败（失败即关闭）；清单外带 user_id 的表（比如允许系统事件 NULL 的审计表）
#         只打一行信息，不拦发布。
# 检查 2  『owner』与 NULL 会不会撞唯一索引：迁移 0023/0024 把 NULL 改成 'owner'。按迁移后的表达式
#         （coalesce(user_id,'owner') + 各索引原有列和条件）试算重复，撞了就失败。表名 + 重复组数，不打印任何数据内容。
# 检查 3  逐表行数可读（scripts/lib/table-counts.sql），结果存 $RELEASE_ROOT/.release/precheck-<时间>.counts.tsv，
#         部署后可对照。
# 检查 4  生产 deploy/.env 里 SHELL_OWNER_EMAIL 已设置且非空（只判断有没有值，不打印值）。
# 检查 5  MCP 专用网段（.env 的 MCP_NET_SUBNET，默认 172.29.77.0/29）没有被主机上别的 docker 网络或路由占用
#         （docker network inspect + ip route，只读）。冲突则失败，提示改 MCP_NET_SUBNET 与 CORE_MCP_IP。
#         Aroomo 自己的 aroomo_aroomo-mcp 网络（上次部署建的）不算冲突。
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
for a in "$@"; do
  case "$a" in
    --no-backup) do_backup=0 ;;
    *) echo "用法：release-precheck.sh [--no-backup]" >&2; exit 64 ;;
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
bad_tables=""
null_bad=""
nullable_info=""
rls_checked=0
for t in "${rls_tables[@]}"; do
  ident_ok "$t" || { fail "检查 1 清单里表名不合法：$t"; continue; }
  if ! printf '%s\n' "$tables" | grep -qx "$t"; then
    fail "检查 1 RLS 表 $t 不存在或没有文本列 user_id（schema 不对或连错了库？）"; continue
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
  printf '%s\n' "${rls_tables[@]}" | grep -qx "$t" || others="$others $t"
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
[ -z "$nullable_info" ] || say "信息  user_id 为 NULL 的行（迁移 0023/0024 会改成 'owner'）：${nullable_info# }"
[ -z "$others" ] || say "信息  清单外带 user_id 的表（没开 RLS，不检查）：${others# }"

# ---------------------------------------------------------------------------
# 检查 2：迁移后唯一索引试算。每行：表|其他键列|条件
has_user_id() { printf '%s\n' "$tables" | grep -qx "$1"; }
# 0 = 存在；1 = 不存在；2 = 查询出错
table_exists() { local r; r="$(sql "select to_regclass('public.$1') is not null")" || return 2; [ "$r" = t ]; }

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
# 检查 4：SHELL_OWNER_EMAIL 已设置且非空（只看有没有值，绝不打印）
env_file="$ROOT/deploy/.env"
env_val() { # env_val <键>：取 .env 里最后一次出现的值，去掉首尾空白和成对引号；不输出到日志
  local v
  v="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}
if [ ! -f "$env_file" ]; then
  fail "检查 4 找不到 deploy/.env"
elif [ -n "$(env_val SHELL_OWNER_EMAIL)" ]; then
  pass "检查 4 deploy/.env 里 SHELL_OWNER_EMAIL 已设置（不显示值）"
else
  fail "检查 4 deploy/.env 里 SHELL_OWNER_EMAIL 没有设置或为空（所有者邮箱，控制台据此认主人；请主会话在服务器上补上）"
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
    if ! printf '%s' "$last" | grep -q '"status":"ok"'; then
      fail "部署前备份：结果不是 ok（${last:0:120}）"
    elif ! printf '%s' "$last" | grep -q '"offsite":true'; then
      fail "部署前备份：没有上传到异地 R2（offsite 不是 true），不算数"
    elif ! printf '%s' "$last" | grep -q '"checked":true'; then
      fail "部署前备份：没有从 R2 重新下载核对（checked 不是 true），不算数"
    elif [ -z "$snap" ] || [ -z "$size" ] || [ "$size" -le 0 ]; then
      fail "部署前备份：结果里没有备份名或大小为 0"
    else
      listing="$(run_snaps 2>/dev/null || true)"
      if printf '%s\n' "$listing" | grep -qxF "$snap.tar.zst.age"; then
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
