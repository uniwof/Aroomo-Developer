#!/usr/bin/env bash
# 生产前检查 + 部署前备份（工单 #229 / D253）。任何一项不过就退出码 1，release-tag.sh 因此拒绝部署。
#
#   scripts/release-precheck.sh               三项检查 + 部署前加密备份到 R2 并核对
#   scripts/release-precheck.sh --no-backup   只做检查（演练用，不备份）
#
# 检查 1  所有带 user_id（文本列）的表里不能有空串 user_id（RLS 迁移会加 CHECK (user_id <> '')，空串行会让迁移失败，
#         或在策略里被当作「未设置」）。有就列出表名 + 行数并失败。
#         NULL 同样算失败：CHECK (user_id <> '') 对 NULL 放行，而 RLS 下 user_id = x 对 NULL 行永远不成立，
#         行还在但谁都看不见。只有 NULL_BACKFILL_TABLES 里的表（迁移 0023 inbox_items、0024 provider_keys
#         会先把 NULL 改成 'owner' 再加约束）可以有 NULL。以后新增「迁移里回填 NULL」的表要同步改这个清单。
# 检查 2  『owner』与 NULL 会不会撞唯一索引：迁移 0023/0024 把 NULL 改成 'owner'。按迁移后的表达式
#         （coalesce(user_id,'owner') + 各索引原有列和条件）试算重复，撞了就失败。表名 + 重复组数，不打印任何数据内容。
# 检查 3  逐表行数可读（scripts/lib/table-counts.sql），结果存 $RELEASE_ROOT/.release/precheck-<时间>.counts.tsv，
#         部署后可对照。
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
NULL_BACKFILL_TABLES=" inbox_items provider_keys "

ident_ok() { [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]]; }

say "== 生产前检查 $(date '+%F %T %Z') =="

if ! reach="$(sql 'select 1' 2>&1)" || [ "$reach" != 1 ]; then
  fail "连不上数据库 $DB（只读查询失败）"
  say "共 $failures 项失败，拒绝部署"
  exit 1
fi
pass "数据库可连接（只读）"

# ---------------------------------------------------------------------------
# 检查 1：空串 user_id
tables="$(sql "select c.table_name from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'user_id' and c.data_type in ('text', 'character varying')
  order by 1")"
bad_tables=""
null_bad=""
nullable_info=""
while IFS= read -r t; do
  [ -n "$t" ] || continue
  ident_ok "$t" || { fail "表名不合法，拒绝拼接查询：$t"; continue; }
  n="$(sql "select count(*) from public.\"$t\" where user_id = ''")" || { fail "检查 1 查询 $t 出错"; continue; }
  if [ "$n" != 0 ]; then bad_tables="$bad_tables $t=$n"; fi
  nulls="$(sql "select count(*) from public.\"$t\" where user_id is null")" || nulls=0
  owners="$(sql "select count(*) from public.\"$t\" where user_id = 'owner'")" || owners=0
  if [ "$nulls" != 0 ]; then
    if [[ "$NULL_BACKFILL_TABLES" == *" $t "* ]]; then nullable_info="$nullable_info $t(NULL=$nulls,owner=$owners)"
    else null_bad="$null_bad $t=$nulls"; fi
  fi
done <<<"$tables"
table_count="$(printf '%s\n' "$tables" | grep -c . || true)"
if [ -n "$bad_tables" ]; then
  fail "检查 1 空串 user_id：${bad_tables# }（表=行数；先改成 'owner' 或真实账号再部署）"
else
  pass "检查 1 空串 user_id：检查了 $table_count 张带 user_id 的表，没有空串"
fi
if [ -n "$null_bad" ]; then
  fail "检查 1 NULL user_id：${null_bad# }（表=行数；这些表的迁移不会回填 NULL，加了 RLS 后这些行谁都看不见；先改成 'owner' 或真实账号）"
else
  pass "检查 1 NULL user_id：除迁移会回填的表外没有 NULL"
fi
[ -z "$nullable_info" ] || say "信息  user_id 为 NULL 的行（迁移 0023/0024 会改成 'owner'）：${nullable_info# }"

# ---------------------------------------------------------------------------
# 检查 2：迁移后唯一索引试算。每行：表|其他键列|条件
has_user_id() { printf '%s\n' "$tables" | grep -qx "$1"; }
table_exists() { [ "$(sql "select to_regclass('public.$1') is not null")" = t ]; }

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
  if ! table_exists "$t"; then say "信息  表 $t 还不存在，跳过试算"; continue; fi
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
