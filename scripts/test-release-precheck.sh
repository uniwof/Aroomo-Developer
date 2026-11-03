#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2001,SC2089,SC2090
# release-precheck.sh 的测试（工单 #229）：真 PostgreSQL + 假备份命令。
#   用一条能「从 stdin 读一条 SQL、连到 \$PGDATABASE」的命令：
#   RELEASE_TEST_PSQL="psql -X -q -A -t -v ON_ERROR_STOP=1" PGHOST=… PGUSER=… scripts/test-release-precheck.sh
# 没设 RELEASE_TEST_PSQL、本机也没有 psql 时跳过（退出 0）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${RELEASE_TEST_PSQL:-}" ]; then
  if command -v psql >/dev/null 2>&1 && [ -n "${PGHOST:-}" ]; then
    RELEASE_TEST_PSQL="psql -X -q -A -t -v ON_ERROR_STOP=1"
  else
    echo "跳过：没有 RELEASE_TEST_PSQL，也没有 psql + PGHOST"; exit 0
  fi
fi
work="$(mktemp -d)"
dbname="precheck_test_$$"
export PGDATABASE=postgres
# shellcheck disable=SC2086
adm() { printf '%s\n' "$1" | $RELEASE_TEST_PSQL; }
cleanup() { PGDATABASE=postgres adm "drop database if exists $dbname" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
adm "create database $dbname" >/dev/null
export PGDATABASE="$dbname"

fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

mkdir -p "$work/scripts/lib" "$work/.release"
cp "$here/lib/table-counts.sql" "$here/lib/rls-tables.txt" "$work/scripts/lib/"
cp "$here/release-precheck.sh" "$work/scripts/"
pre="$work/scripts/release-precheck.sh"

# 假备份：成功 / 失败 / 没上传 / 列表里没有
bk="$work/bk.sh"
cat >"$bk" <<'B'
#!/usr/bin/env bash
echo run >>"$BK_CALLS"
case "${BK_MODE:-ok}" in
  ok) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-20261103T100000Z","sha256":"abc","size_bytes":1234,"databases":3,"offsite":true,"checked":true}' ;;
  unchecked) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-20261103T100000Z","size_bytes":1234,"offsite":true,"checked":false}' ;;
  fail) echo "备份失败：没有公钥" >&2; exit 1 ;;
  local) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-x","size_bytes":10,"offsite":false}' ;;
  zero) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-x","size_bytes":0,"offsite":true,"checked":true}' ;;
esac
B
snaps="$work/snaps.sh"
cat >"$snaps" <<'S'
#!/usr/bin/env bash
case "${SNAP_MODE:-has}" in
  has) echo "aroomo-20261103T100000Z.tar.zst.age" ;;
  substr) echo "aroomo-20261103T100000Z.tar.zst.age.partial"; echo "x-aroomo-20261103T100000Z.tar.zst.age" ;;
  *) echo "aroomo-other.tar.zst.age" ;;
esac
S
chmod +x "$bk" "$snaps"
export BK_CALLS="$work/bk.calls"; : >"$BK_CALLS"
# 假 docker 网络 / 路由（检查 5）：内容由 NETS_MODE / ROUTE_MODE 控制
nets="$work/nets.sh"
cat >"$nets" <<'N'
#!/usr/bin/env bash
echo "bridge 1111111111111111aaaa 172.17.0.0/16"
echo "host 2222222222222222bbbb"
case "${NETS_MODE:-ok}" in
  own) echo "aroomo_aroomo-mcp 3333333333333333cccc 172.29.77.0/29" ;;
  clash) echo "other_net 4444444444444444dddd 172.29.0.0/16 fd00::/64" ;;
  broken) exit 1 ;;
esac
N
routes="$work/routes.sh"
cat >"$routes" <<'R'
#!/usr/bin/env bash
echo "default via 10.0.0.1 dev eth0 proto dhcp"
echo "10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.5"
echo "172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1"
case "${ROUTE_MODE:-ok}" in
  own) echo "172.29.77.0/29 dev br-333333333333 proto kernel scope link src 172.29.77.1" ;;
  clash) echo "172.29.77.4 dev tun0 scope link" ;;
esac
R
chmod +x "$nets" "$routes"
mkdir -p "$work/deploy"
envf="$work/deploy/.env"
printf 'CORE_CHAT_TOKEN=abc\nSHELL_OWNER_EMAIL=owner-secret-mark@example.com\n' >"$envf"
export RELEASE_ROOT="$work" RELEASE_PSQL="$RELEASE_TEST_PSQL" RELEASE_BACKUP_CMD="$bk" RELEASE_SNAPSHOTS_CMD="$snaps"
export RELEASE_DOCKER_NETS_CMD="$nets" RELEASE_IP_ROUTE_CMD="$routes"

adm "create table members (user_id text not null default 'owner', id text, name text, deleted_at timestamptz)" >/dev/null
adm "create table inbox_items (id serial, user_id text, kind text, related_type text, related_id text, status text)" >/dev/null
adm "create table provider_keys (id serial, user_id text, name text)" >/dev/null
adm "create table library_items (user_id text not null, url text)" >/dev/null
adm "create table users (id uuid primary key)" >/dev/null
adm "create table vault_secrets (id serial, user_id text not null, name text, deleted_at timestamptz)" >/dev/null
adm "create table public_memory (user_id text not null, topic text)" >/dev/null
adm "create table public_memory_versions (user_id text not null, topic text, version int)" >/dev/null
adm "create table audit_log (id serial, user_id text, action text)" >/dev/null
adm "insert into audit_log (user_id, action) values (null, 'system-event')" >/dev/null
adm "insert into members values ('owner','m1','小明',null),('u-b','m2','小明',null)" >/dev/null
adm "insert into inbox_items (user_id,kind,related_type,related_id,status) values (null,'k','t','1','open'),('u-b','k','t','1','open'),(null,'k','t','2','done')" >/dev/null
adm "insert into provider_keys (user_id,name) values (null,'a')" >/dev/null
adm "insert into library_items values ('owner','https://x'),('u-b','https://x')" >/dev/null

run() { # run <说明> <期望退出码> [参数…]
  local name="$1" want="$2"; shift 2
  local rc=0
  OUT="$("$pre" "$@" 2>&1)" || rc=$?
  if [ "$rc" = "$want" ]; then ok "$name"; else bad "$name（退出码 $rc，期望 $want）"; echo "$OUT" | sed 's/^/     /'; fi
}
has() { echo "$OUT" | grep -qF "$1" && ok "输出含「$1」" || { bad "输出缺「$1」"; echo "$OUT" | sed 's/^/     /'; }; }

run "干净库：全部通过（含备份）" 0
has "检查 1 空串 user_id"; has "检查 2 唯一索引试算"; has "检查 3 逐表行数可读"; has "aroomo-20261103T100000Z"
has "检查了 7 张开了 RLS 的表"; has "检查 4"; has "检查 5"
has "清单外带 user_id 的表"
echo "$OUT" | grep -q 'owner-secret-mark' && bad "输出里出现了 SHELL_OWNER_EMAIL 的值" || ok "不打印 SHELL_OWNER_EMAIL 的值"
[ -f "$work/.release/precheck.ok" ] && ok "记下了备份通过标记" || bad "没有备份通过标记"
ls "$work"/.release/precheck-*.counts.tsv >/dev/null 2>&1 && ok "存了逐表行数" || bad "没存逐表行数"

: >"$BK_CALLS"
run "--no-backup 不备份" 0 --no-backup
[ ! -s "$BK_CALLS" ] && ok "--no-backup 没调用备份" || bad "--no-backup 却调用了备份"

# 备份各种失败
BK_MODE=fail run "备份失败则拒绝部署" 1
BK_MODE=local run "备份没上传 R2 则拒绝" 1
BK_MODE=zero run "备份大小为 0 则拒绝" 1
BK_MODE=unchecked run "备份没从 R2 重新下载核对则拒绝" 1
SNAP_MODE=none run "备份名不在列表里则拒绝" 1
SNAP_MODE=substr run "列表里只有名字的子串（不完全相等）则拒绝" 1

# 检查 2：NULL 与 'owner' 撞唯一索引
adm "insert into inbox_items (user_id,kind,related_type,related_id,status) values ('owner','k','t','1','open')" >/dev/null
: >"$BK_CALLS"
run "inbox 里 NULL 与 owner 同一条 open 记录 → 失败" 1
has "inbox_items=1组"
[ ! -s "$BK_CALLS" ] && ok "检查失败时不做备份" || bad "检查失败却做了备份"
adm "delete from inbox_items where user_id = 'owner'" >/dev/null
run "撞车消除后恢复通过" 0

# 不同账号相同内容不算撞（跨账号：A 和 B 各一条）
run "不同账号的相同记录不算重复" 0 --no-backup

# 检查 1：空串 user_id
adm "insert into library_items values ('','https://y')" >/dev/null
run "library_items 有空串 user_id → 失败" 1 --no-backup
has "library_items=1"
adm "delete from library_items where user_id = ''" >/dev/null
adm "update provider_keys set user_id = '' where name = 'a'" >/dev/null
run "provider_keys 有空串 user_id → 失败" 1 --no-backup
has "provider_keys=1"
adm "update provider_keys set user_id = null" >/dev/null
run "改回 NULL 后通过（provider_keys 的 NULL 迁移 0024 会回填）" 0 --no-backup

# 检查 1：不在回填清单里的 RLS 表有 NULL → 失败（CHECK 放行 NULL，但 RLS 下这些行谁都看不见）
adm "alter table vault_secrets alter column user_id drop not null" >/dev/null
adm "insert into vault_secrets (user_id,name) values (null,'a'),('u-b','b')" >/dev/null
run "vault_secrets 有 NULL user_id（迁移不回填）→ 失败" 1 --no-backup
has "vault_secrets=1"
adm "update vault_secrets set user_id = 'owner' where user_id is null" >/dev/null
run "NULL 改成 owner 后通过" 0 --no-backup

# 检查 1：清单外的表（审计表允许系统事件 user_id 为 NULL）有 NULL 照样通过
adm "insert into audit_log (user_id, action) values (null, 'x'), ('', 'y')" >/dev/null
run "清单外的表有 NULL / 空串：照样通过" 0 --no-backup
has "audit_log"
# 检查 1：清单里的表不存在 → 失败
adm "alter table public_memory_versions rename to pmv_hidden" >/dev/null
run "RLS 清单里的 public_memory_versions 不存在 → 失败" 1 --no-backup
has "public_memory_versions 不存在"
adm "alter table pmv_hidden rename to public_memory_versions" >/dev/null
# 检查 1：查询出错不能当成 0（权限被收回时 count 出错）
adm "create role precheck_ro login" >/dev/null 2>&1 || true
adm "grant connect on database $dbname to precheck_ro" >/dev/null
adm "grant usage on schema public to precheck_ro" >/dev/null
adm "grant select on all tables in schema public to precheck_ro" >/dev/null
adm "revoke select on provider_keys from precheck_ro" >/dev/null
OUT="$(RELEASE_PSQL="$RELEASE_TEST_PSQL -U precheck_ro" "$pre" --no-backup 2>&1)" && rc=0 || rc=$?
[ "$rc" = 1 ] && echo "$OUT" | grep -q 'provider_keys' && ok "查询 provider_keys 出错 → 失败（不当成 0）" || { bad "查询出错却通过（退出码 $rc）"; echo "$OUT" | sed 's/^/     /'; }
adm "drop owned by precheck_ro" >/dev/null 2>&1 || true
adm "drop role precheck_ro" >/dev/null 2>&1 || true
# 清单文件丢了 → 失败
mv "$work/scripts/lib/rls-tables.txt" "$work/rls.bak"
run "没有 RLS 表清单 → 失败" 1 --no-backup
mv "$work/rls.bak" "$work/scripts/lib/rls-tables.txt"

# 检查 4：SHELL_OWNER_EMAIL
cp "$envf" "$work/env.bak"
sed -i '/^SHELL_OWNER_EMAIL=/d' "$envf"
run "没有 SHELL_OWNER_EMAIL → 失败" 1 --no-backup
has "SHELL_OWNER_EMAIL 没有设置或为空"
echo 'SHELL_OWNER_EMAIL=' >>"$envf"
run "SHELL_OWNER_EMAIL 为空 → 失败" 1 --no-backup
echo 'SHELL_OWNER_EMAIL=""' >>"$envf"
run "SHELL_OWNER_EMAIL 是空引号 → 失败" 1 --no-backup
echo "SHELL_OWNER_EMAIL='  '" >>"$envf"
run "SHELL_OWNER_EMAIL 只有空白 → 失败" 1 --no-backup
cp "$work/env.bak" "$envf"
mv "$envf" "$work/env.moved"
run "没有 deploy/.env → 失败" 1 --no-backup
mv "$work/env.moved" "$envf"
run "SHELL_OWNER_EMAIL 恢复后通过" 0 --no-backup

# 检查 5：MCP 网段冲突
NETS_MODE=clash run "别的 docker 网络占了 172.29.77.0/29 → 失败" 1 --no-backup
has "MCP_NET_SUBNET"; has "CORE_MCP_IP"; has "other_net"
ROUTE_MODE=clash run "主机路由落在 MCP 网段里 → 失败" 1 --no-backup
has "tun0"
NETS_MODE=own ROUTE_MODE=own run "Aroomo 自己的 aroomo_aroomo-mcp 网络（及其网桥路由）不算冲突" 0 --no-backup
NETS_MODE=broken run "读不出 docker 网络 → 失败" 1 --no-backup
echo 'MCP_NET_SUBNET=172.30.88.0/29' >>"$envf"
NETS_MODE=clash run "改了 MCP_NET_SUBNET 后不再冲突" 0 --no-backup
has "172.30.88.0/29"
echo 'MCP_NET_SUBNET=not-a-subnet' >>"$envf"
run "MCP_NET_SUBNET 不合法 → 失败" 1 --no-backup
cp "$work/env.bak" "$envf"
: >"$BK_CALLS"
NETS_MODE=clash run "检查 5 失败 → 拒绝部署" 1
[ ! -s "$BK_CALLS" ] && ok "检查 5 失败时不做备份" || bad "检查 5 失败却做了备份"

# 第一次部署的真实情况：precheck 从临时目录运行，RELEASE_ROOT 指向的生产目录里还没有 scripts/lib/
prod="$work/prod-first"
mkdir -p "$prod/deploy"; cp "$envf" "$prod/deploy/.env"
OUT="$(RELEASE_ROOT="$prod" "$pre" --no-backup 2>&1)" && rc=0 || rc=$?
[ "$rc" = 0 ] && ok "第一次部署：生产目录没有 scripts/lib/ 也能通过（用脚本旁边的 lib/）" || { bad "第一次部署失败（退出码 $rc）"; echo "$OUT" | sed 's/^/     /'; }
[ ! -e "$prod/scripts" ] && ok "第一次部署：没有往生产目录写 scripts/" || bad "往生产目录写了 scripts/"

# 连不上
PGDATABASE=no_such_db_$$ run "连不上数据库 → 失败" 1 --no-backup

# 只读：脚本不改数据
before="$(printf '%s\n' "select count(*) from inbox_items" | $RELEASE_TEST_PSQL)"
"$pre" --no-backup >/dev/null 2>&1 || true
after="$(printf '%s\n' "select count(*) from inbox_items" | $RELEASE_TEST_PSQL)"
[ "$before" = "$after" ] && ok "不改数据" || bad "数据被改了"

[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
