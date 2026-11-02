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
cp "$here/lib/table-counts.sql" "$work/scripts/lib/"
cp "$here/release-precheck.sh" "$work/scripts/"
pre="$work/scripts/release-precheck.sh"

# 假备份：成功 / 失败 / 没上传 / 列表里没有
bk="$work/bk.sh"
cat >"$bk" <<'B'
#!/usr/bin/env bash
echo run >>"$BK_CALLS"
case "${BK_MODE:-ok}" in
  ok) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-20261103T100000Z","sha256":"abc","size_bytes":1234,"databases":3,"offsite":true}' ;;
  fail) echo "备份失败：没有公钥" >&2; exit 1 ;;
  local) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-x","size_bytes":10,"offsite":false}' ;;
  zero) echo '{"event":"backup","status":"ok","snapshot_id":"aroomo-x","size_bytes":0,"offsite":true}' ;;
esac
B
snaps="$work/snaps.sh"
cat >"$snaps" <<'S'
#!/usr/bin/env bash
case "${SNAP_MODE:-has}" in has) echo "aroomo-20261103T100000Z.tar.zst.age" ;; *) echo "aroomo-other.tar.zst.age" ;; esac
S
chmod +x "$bk" "$snaps"
export BK_CALLS="$work/bk.calls"; : >"$BK_CALLS"
export RELEASE_ROOT="$work" RELEASE_PSQL="$RELEASE_TEST_PSQL" RELEASE_BACKUP_CMD="$bk" RELEASE_SNAPSHOTS_CMD="$snaps"

adm "create table members (user_id text not null default 'owner', id text, name text, deleted_at timestamptz)" >/dev/null
adm "create table inbox_items (id serial, user_id text, kind text, related_type text, related_id text, status text)" >/dev/null
adm "create table provider_keys (id serial, user_id text, name text)" >/dev/null
adm "create table library_items (user_id text not null, url text)" >/dev/null
adm "create table users (id uuid primary key)" >/dev/null
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
[ -f "$work/.release/precheck.ok" ] && ok "记下了备份通过标记" || bad "没有备份通过标记"
ls "$work"/.release/precheck-*.counts.tsv >/dev/null 2>&1 && ok "存了逐表行数" || bad "没存逐表行数"

: >"$BK_CALLS"
run "--no-backup 不备份" 0 --no-backup
[ ! -s "$BK_CALLS" ] && ok "--no-backup 没调用备份" || bad "--no-backup 却调用了备份"

# 备份各种失败
BK_MODE=fail run "备份失败则拒绝部署" 1
BK_MODE=local run "备份没上传 R2 则拒绝" 1
BK_MODE=zero run "备份大小为 0 则拒绝" 1
SNAP_MODE=none run "备份名不在列表里则拒绝" 1

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
run "改回 NULL 后通过" 0 --no-backup

# 连不上
PGDATABASE=no_such_db_$$ run "连不上数据库 → 失败" 1 --no-backup

# 只读：脚本不改数据
before="$(printf '%s\n' "select count(*) from inbox_items" | $RELEASE_TEST_PSQL)"
"$pre" --no-backup >/dev/null 2>&1 || true
after="$(printf '%s\n' "select count(*) from inbox_items" | $RELEASE_TEST_PSQL)"
[ "$before" = "$after" ] && ok "不改数据" || bad "数据被改了"

[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
