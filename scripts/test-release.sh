#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2001
# release-tag.sh 的本机测试（工单 #171）：用临时 git 仓库 + 假的 compose.sh，不需要 docker。
#   scripts/test-release.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
expect() { # expect <说明> <期望退出码> <命令...>
  local name="$1" want="$2"; shift 2
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  if [ "$rc" = "$want" ]; then ok "$name"; else bad "$name（退出码 $rc，期望 $want）"; echo "$out" | sed 's/^/     /'; fi
  LAST_OUT="$out"
}

origin="$work/origin.git"; seed="$work/seed"; root="$work/prod"
git init -q --bare -b main "$origin"
git init -q -b main "$seed"
mkdir -p "$seed/scripts" "$seed/deploy"
cat >"$seed/scripts/compose.sh" <<'STUB'
#!/usr/bin/env bash
# 假 compose：记录调用；工作树里有 FAIL_UP 文件就让 up 失败
cd "$(dirname "$0")/.."
echo "$(git rev-parse --short HEAD) $*" >>"${RELEASE_TEST_CALLS:?}"
if [ "${1:-}" = up ] && [ -f FAIL_UP ]; then exit 1; fi
exit 0
STUB
chmod +x "$seed/scripts/compose.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$seed/scripts/build-console.sh"; chmod +x "$seed/scripts/build-console.sh"
commit() { git -C "$seed" add -A && git -C "$seed" commit -q -m "$1"; }
mkdir -p "$seed/core/migrations"
echo one >"$seed/a.txt"; echo "select 1;" >"$seed/core/migrations/0001_a.sql"; commit "第一版"; git -C "$seed" tag v0.1.0
# v0.2.0 起带合并闸门和生产前检查（桩）：它们必须取自目标版本，状态由 \$RELEASE_ROOT 下的文件控制
cat >"$seed/scripts/merge-gate.sh" <<'G'
#!/usr/bin/env bash
[ -f "${RELEASE_ROOT:?}/GATE_FAIL" ] && { echo "闸门桩：不通过"; exit 1; }
exit 0
G
cat >"$seed/scripts/release-precheck.sh" <<'G'
#!/usr/bin/env bash
echo "$*" >>"${RELEASE_ROOT:?}/precheck.args"
[ -f "$RELEASE_ROOT/PRECHECK_FAIL" ] && { echo "检查桩：不通过"; exit 1; }
exit 0
G
chmod +x "$seed/scripts/merge-gate.sh" "$seed/scripts/release-precheck.sh"
echo two >"$seed/a.txt"; echo "select 2;" >"$seed/core/migrations/0002_b.sql"; commit "第二版"; git -C "$seed" tag v0.2.0
touch "$seed/FAIL_UP"; echo "select 3;" >"$seed/core/migrations/0003_c.sql"; commit "坏版本（up 会失败）"; git -C "$seed" tag v0.3.0
git -C "$seed" push -q "$origin" main --tags
# dev 上有一个没进 main 的标签
git -C "$seed" checkout -q -b dev; echo dev >"$seed/a.txt"; commit "只在 dev"; git -C "$seed" tag v0.9.0
git -C "$seed" push -q "$origin" dev v0.9.0

git clone -q "$origin" "$root"
git -C "$root" checkout -q -f "$(git -C "$seed" rev-parse v0.1.0)" 2>/dev/null
# 生产的 .env 自检需要：有 CORE_CHAT_TOKEN 和 32 字节的 KEY_VAULTS_SECRET；另放两个本地密钥文件，确认不会被动
mkdir -p "$root/deploy"
{ echo "CORE_CHAT_TOKEN=abc"; echo "KEY_VAULTS_SECRET=$(head -c 32 /dev/zero | base64)"; } >"$root/deploy/.env"
echo local-secret >"$root/deploy/.lobehub-cli-key"

export RELEASE_ROOT="$root" RELEASE_TEST_CALLS="$work/calls.log" RELEASE_SKIP_CONSOLE=1 RELEASE_HEALTH_POLL_S=0
export RELEASE_HEALTH_TIMEOUT_S=2 RELEASE_REQUIRE_PRECHECK=1
health="$work/health.sh"
cat >"$health" <<'H'
#!/usr/bin/env bash
cd "$RELEASE_ROOT"; if [ -f FAIL_UP ]; then echo unhealthy; else echo healthy; fi
H
chmod +x "$health"; export RELEASE_HEALTH_CMD="$health"
# 假数据库：已执行的迁移列在 \$applied 文件里（一行一个）
applied="$work/applied"; printf '0001_a.sql\n0002_b.sql\n' >"$applied"
dbcmd="$work/db.sh"
cat >"$dbcmd" <<D
#!/usr/bin/env bash
q="\$(cat)"
case "\$q" in *to_regclass*) echo core_schema_migrations ;; *) cat "$applied" ;; esac
D
chmod +x "$dbcmd"; export RELEASE_DB_CMD="$dbcmd"
: >"$RELEASE_TEST_CALLS"
rel="$here/release-tag.sh"
head_tag() { git -C "$root" describe --tags --exact-match HEAD 2>/dev/null || echo none; }

expect "list 只列 main 上的标签" 0 "$rel" list
echo "$LAST_OUT" | grep -q 'v0.2.0' && ! echo "$LAST_OUT" | grep -q 'v0.9.0' && ok "list 含 v0.2.0、不含 dev 标签 v0.9.0" || bad "list 内容不对：$LAST_OUT"

expect "拒绝 dev 上的标签" 1 "$rel" deploy v0.9.0
expect "拒绝不是 vX.Y.Z 的名字" 1 "$rel" deploy dev
expect "拒绝分支名 main" 1 "$rel" deploy main
expect "拒绝不存在的标签" 1 "$rel" deploy v7.7.7

expect "演练不切换" 0 "$rel" deploy v0.2.0
echo "$LAST_OUT" | grep -q '需要主会话：确认生产切到标签版' && ok "演练打印确认提示" || bad "演练没有确认提示"
[ "$(head_tag)" = v0.1.0 ] && ok "演练后仍是 v0.1.0" || bad "演练改变了检出：$(head_tag)"
expect "确认的版本号写错不切换" 0 "$rel" deploy v0.2.0 --confirm v0.1.0
[ "$(head_tag)" = v0.1.0 ] && ok "写错确认仍不切换" || bad "写错确认却切换了"

expect "确认后切到 v0.2.0" 0 "$rel" deploy v0.2.0 --confirm v0.2.0
[ "$(head_tag)" = v0.2.0 ] && ok "检出 v0.2.0" || bad "检出不对：$(head_tag)"
[ "$(cat "$root/.release/current")" = v0.2.0 ] && ok "current=v0.2.0" || bad "current 状态不对"
[ -f "$root/deploy/.lobehub-cli-key" ] && ok "本地密钥文件未被动" || bad "本地密钥文件被删了"
grep -q 'up -d' "$RELEASE_TEST_CALLS" && ok "调用了 compose up -d" || bad "没有 compose up"

expect "切到坏版本 v0.3.0 失败并自动回到 v0.2.0（迁移没执行，数据库没变）" 1 "$rel" deploy v0.3.0 --confirm v0.3.0
[ "$(head_tag)" = v0.2.0 ] && ok "失败后回到 v0.2.0" || bad "失败后检出：$(head_tag)"
[ "$(cat "$root/.release/current")" = v0.2.0 ] && ok "失败后 current 仍是 v0.2.0" || bad "失败后 current 变了"

# 回滚前先看数据库：已执行 0002，而回滚目标 v0.1.0 不认识它 → 拒绝（演练和确认都拒绝），代码不动
expect "回滚演练：数据库已迁移到 0002 时拒绝" 1 "$rel" rollback
echo "$LAST_OUT" | grep -q '需要人工处理' && echo "$LAST_OUT" | grep -q '0002_b.sql' && ok "拒绝理由写明迁移名和人工处理" || bad "拒绝理由不对：$LAST_OUT"
expect "确认回滚也拒绝（迁移超前）" 1 "$rel" rollback --confirm "$(cat "$root/.release/previous")"
[ "$(head_tag)" = v0.2.0 ] && ok "拒绝后仍是 v0.2.0" || bad "拒绝后检出变了：$(head_tag)"

printf '0001_a.sql\n' >"$applied"   # 假设 v0.2.0 没有真正执行过 0002
expect "回滚演练" 0 "$rel" rollback
expect "一键回滚到上一个（v0.1.0 之前的记录是 v0.1.0 的提交）" 0 "$rel" rollback --confirm "$(cat "$root/.release/previous")"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "回滚后是 v0.1.0 的提交" || bad "回滚后检出不对"
[ "$(cat "$root/.release/previous")" = v0.2.0 ] && ok "回滚后 previous=v0.2.0（可再切回）" || bad "previous 状态不对"
printf '0001_a.sql\n0002_b.sql\n' >"$applied"

# 工作区里已跟踪的文件被手工改过：演练和确认都拒绝，不 --force，改动原样保留，输出只有文件名
echo "手工修改" >>"$root/a.txt"
expect "已跟踪文件有改动：演练拒绝" 1 "$rel" deploy v0.2.0
echo "$LAST_OUT" | grep -q 'a.txt' && ! echo "$LAST_OUT" | grep -q '手工修改' && ok "只列文件名，不列内容" || bad "输出不对：$LAST_OUT"
expect "已跟踪文件有改动：确认也拒绝" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
grep -q '手工修改' "$root/a.txt" && ok "手工修改原样保留" || bad "手工修改被丢了"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "没有切走" || bad "脏工作区却切走了"
git -C "$root" checkout -q -- a.txt

# 没有 .env 必需项时：演练就拒绝（不用等到切换），也不自动生成
sed -i '/^CORE_CHAT_TOKEN=/d' "$root/deploy/.env"
expect "缺 CORE_CHAT_TOKEN：演练就拒绝" 1 "$rel" deploy v0.2.0
expect "缺 CORE_CHAT_TOKEN：确认也拒绝" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "缺 token 时没有切走" || bad "缺 token 却切走了"
grep -q '^CORE_CHAT_TOKEN=' "$root/deploy/.env" && bad "脚本自动生成了 token" || ok "不自动生成 token"
echo "CORE_CHAT_TOKEN=abc" >>"$root/deploy/.env"

# 合并闸门取自目标版本（v0.2.0 带桩）：不过则拒绝；hotfix 跳过。生产现在的 v0.1.0 里根本没有这个脚本
touch "$root/GATE_FAIL"
expect "合并闸门（目标版本里的）不过则拒绝" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "闸门不过时没有切走" || bad "闸门不过却切走了"
expect "hotfix 跳过闸门" 0 "$rel" deploy v0.2.0 --confirm v0.2.0 --hotfix
rm -f "$root/GATE_FAIL"
[ "$(head_tag)" = v0.2.0 ] && ok "现在是 v0.2.0" || bad "hotfix 后检出：$(head_tag)"

# 生产前检查：目标版本里没有 → 拒绝；有但失败 → 拒绝；演练带 --no-backup，真切换不带
RELEASE_REQUIRE_PRECHECK=1 expect "目标版本（v0.1.0）没有 release-precheck.sh：拒绝部署" 1 "$rel" deploy v0.1.0 --confirm v0.1.0
touch "$root/PRECHECK_FAIL"
expect "生产前检查（目标版本里的）失败则不切换" 1 "$rel" deploy v0.3.0 --confirm v0.3.0
[ "$(head_tag)" = v0.2.0 ] && ok "检查失败后仍是 v0.2.0" || bad "检查失败却切换了"
rm -f "$root/PRECHECK_FAIL"; : >"$root/precheck.args"
expect "演练调用 precheck --no-backup" 0 "$rel" deploy v0.3.0
grep -qx -- '--no-backup' "$root/precheck.args" && ok "演练只检查不备份" || bad "演练参数不对：$(cat "$root/precheck.args")"

# 迁移已经执行（0003），随后健康检查失败：回退目标 v0.2.0 不认识 0003 → 不自动回退，写「需要人工处理」
printf '0001_a.sql\n0002_b.sql\n0003_c.sql\n' >"$applied"
expect "迁移执行后健康检查失败：不自动回退代码" 1 "$rel" deploy v0.3.0 --confirm v0.3.0
echo "$LAST_OUT" | grep -q '需要人工处理' && echo "$LAST_OUT" | grep -q '0003_c.sql' && echo "$LAST_OUT" | grep -q 'BACKUP.md' && ok "日志写明先用备份恢复" || bad "日志不对：$LAST_OUT"
[ "$(head_tag)" = v0.3.0 ] && ok "代码停在 v0.3.0，没有悄悄退回" || bad "检出不对：$(head_tag)"
[ "$(cat "$root/.release/current")" = v0.2.0 ] && ok "current 仍记录 v0.2.0（没有假装成功）" || bad "current 被改了"
echo "$LAST_OUT" | grep -q '已回到' && bad "却写了已回到旧版本" || ok "没有写已回到旧版本"

# 读不出数据库迁移记录：同样保守处理
git -C "$root" checkout -q -f "$(git -C "$seed" rev-parse v0.2.0)"
printf '#!/usr/bin/env bash\nexit 3\n' >"$work/db-broken.sh"; chmod +x "$work/db-broken.sh"
RELEASE_DB_CMD="$work/db-broken.sh" expect "读不出迁移记录：拒绝部署" 1 "$rel" deploy v0.3.0
echo "$LAST_OUT" | grep -q '读不出数据库的迁移记录' && ok "说明读不出迁移记录" || bad "输出不对：$LAST_OUT"

# compose 输出写进 600 权限的日志文件，不再丢掉
[ "$(stat -c %a "$root/.release/compose.log")" = 600 ] && ok "compose.log 权限 600" || bad "compose.log 权限不对"

if grep -rn 'AGE-SECRET-KEY\|CORE_CHAT_TOKEN=abc' "$root/.release" >/dev/null 2>&1; then bad "状态/日志里出现了密钥"; else ok "日志无密钥"; fi
[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
