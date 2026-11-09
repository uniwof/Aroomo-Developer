#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2001
# release-tag.sh 的本机测试（工单 #171）：用临时 git 仓库 + 假的 compose.sh，不需要 docker。
#   scripts/test-release.sh
set -euo pipefail
umask 022   # 测试本身用常见的 umask，断言 release-tag.sh 不会把文件权限改严
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

# 远端路径以 uniwof/Aroomo-Developer.git 结尾：发布脚本会把远端的 owner/repo 和闸门写死的仓库核对（#352 N1）
origin="$work/gh/uniwof/Aroomo-Developer.git"; seed="$work/seed"; root="$work/prod"
mkdir -p "$(dirname "$origin")"
git init -q --bare -b main "$origin"
git init -q -b main "$seed"
mkdir -p "$seed/scripts" "$seed/deploy"
cat >"$seed/scripts/compose.sh" <<'STUB'
#!/usr/bin/env bash
# 假 compose：记录调用；工作树里有 FAIL_UP 文件就让 up 失败
cd "$(dirname "$0")/.."
echo "$(git rev-parse --short HEAD) $*" >>"${RELEASE_TEST_CALLS:?}"
[ -z "${GH_TOKEN:-}" ] || echo "compose.sh 拿到了 GH_TOKEN" >>"$RELEASE_TEST_CALLS.leak"
if [ "${1:-}" = up ] && [ -f FAIL_UP ]; then exit 1; fi
exit 0
STUB
chmod +x "$seed/scripts/compose.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$seed/scripts/build-console.sh"; chmod +x "$seed/scripts/build-console.sh"
commit() { git -C "$seed" add -A && git -C "$seed" commit -q -m "$1"; }
mkdir -p "$seed/core/migrations"
echo one >"$seed/a.txt"; echo "select 1;" >"$seed/core/migrations/0001_a.sql"; commit "第一版"; git -C "$seed" tag v0.1.0
# v0.2.0 起带合并闸门和生产前检查（桩）：它们必须取自目标版本，状态由 \$RELEASE_ROOT 下的文件控制
mkdir -p "$seed/scripts/ci"
cat >"$seed/scripts/ci/merge-gate.py" <<'G'
# 闸门桩（#351 的 merge-gate.py 的替身）：记下收到的 REPO/TAG_SHA/TAG_NAME、令牌是否到位（不记令牌本身）、是否只读
import os, sys
root = os.environ["RELEASE_ROOT"]
with open(os.path.join(root, "gate.env"), "w") as f:
    f.write("REPO=%s\nTAG_SHA=%s\nTAG_NAME=%s\nTOKEN=%s\nREADONLY=%s\n" % (
        os.environ.get("REPO", ""), os.environ.get("TAG_SHA", ""), os.environ.get("TAG_NAME", ""),
        {"": "unset", "stdin-gate-token-for-test-only": "stdin"}.get(os.environ.get("GH_TOKEN", ""), "other"),
        os.environ.get("MERGE_GATE_READONLY", "")))
if os.path.exists(os.path.join(root, "GATE_FAIL")):
    print("闸门桩：不通过（待审 PR #1）")
    sys.exit(1)
G
cat >"$seed/scripts/release-precheck.sh" <<'G'
#!/usr/bin/env bash
echo "$*" >>"${RELEASE_ROOT:?}/precheck.args"
[ -z "${GH_TOKEN:-}" ] || echo "precheck 拿到了 GH_TOKEN" >>"${RELEASE_TEST_CALLS:?}.leak"
[ -f "$RELEASE_ROOT/PRECHECK_FAIL" ] && { echo "检查桩：不通过"; exit 1; }
exit 0
G
chmod +x "$seed/scripts/release-precheck.sh"
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

export RELEASE_TEST_MODE=1   # 下面的测试开关（#353）只在测试模式下生效
export RELEASE_ROOT="$root" RELEASE_TEST_CALLS="$work/calls.log" RELEASE_SKIP_CONSOLE=1 RELEASE_HEALTH_POLL_S=0
export RELEASE_HEALTH_TIMEOUT_S=2 RELEASE_REQUIRE_PRECHECK=1 RELEASE_REQUIRE_GATE=1
# 假令牌：环境里故意 export 一个（脚本必须清掉、谁都不许拿到）；闸门的令牌从标准输入给（#352 M1）
export GH_TOKEN="fake-env-token-for-test-only"
GATE_TOKEN="stdin-gate-token-for-test-only"
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
relbin="$here/release-tag.sh"
rel_() { printf '%s\n' "$GATE_TOKEN" | "$relbin" "$@"; }   # 令牌走标准输入
rel=rel_
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
[ "$(stat -c %a "$root/a.txt")" = 644 ] && ok "检出的文件权限是 644（没有全局 umask 077）" || bad "检出的文件权限不对：$(stat -c %a "$root/a.txt")"

expect "切到坏版本 v0.3.0 失败并自动回到 v0.2.0（迁移没执行，数据库没变）" 1 "$rel" deploy v0.3.0 --confirm v0.3.0
[ "$(head_tag)" = v0.2.0 ] && ok "失败后回到 v0.2.0" || bad "失败后检出：$(head_tag)"
[ "$(cat "$root/.release/current")" = v0.2.0 ] && ok "失败后 current 仍是 v0.2.0" || bad "失败后 current 变了"

# 回滚前先看数据库：已执行 0002，而回滚目标 v0.1.0 不认识它 → 拒绝（演练和确认都拒绝），代码不动
expect "回滚演练：数据库已迁移到 0002 时拒绝" 1 "$rel" rollback
echo "$LAST_OUT" | grep -q '需要人工处理' && echo "$LAST_OUT" | grep -q '0002_b.sql' && ok "拒绝理由写明迁移名和人工处理" || bad "拒绝理由不对：$LAST_OUT"
expect "确认回滚也拒绝（迁移超前）" 1 "$rel" rollback --confirm "$(cat "$root/.release/previous")"
[ "$(head_tag)" = v0.2.0 ] && ok "拒绝后仍是 v0.2.0" || bad "拒绝后检出变了：$(head_tag)"

printf '0001_a.sql\n' >"$applied"   # 假设 v0.2.0 没有真正执行过 0002
# 回滚不受闸门限制（#352 M5）：闸门会失败、没有令牌（GitHub 不可用 / 令牌过期）时照样能紧急回滚
touch "$root/GATE_FAIL"; rm -f "$root/gate.env"
rel_notok() { "$relbin" "$@" </dev/null; }
expect "回滚演练（闸门会失败、无令牌）" 0 rel_notok rollback
expect "一键回滚到上一个（闸门会失败、无令牌也成功；v0.1.0 之前的记录是 v0.1.0 的提交）" 0 rel_notok rollback --confirm "$(cat "$root/.release/previous")"
[ ! -e "$root/gate.env" ] && ok "回滚没有跑闸门" || bad "回滚跑了闸门"
rm -f "$root/GATE_FAIL"
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
grep -qx 'REPO=uniwof/Aroomo-Developer' "$root/gate.env" && grep -qx "TAG_SHA=$(git -C "$seed" rev-parse v0.2.0)" "$root/gate.env" \
  && grep -qx 'TAG_NAME=v0.2.0' "$root/gate.env" && grep -qx 'TOKEN=stdin' "$root/gate.env" \
  && grep -qx 'READONLY=1' "$root/gate.env" \
  && ok "闸门收到仓库、标签提交、标签名、标准输入读的令牌（不是环境里的），且固定只读" || bad "闸门收到的参数不对：$(cat "$root/gate.env")"
expect "演练也跑闸门，不过则拒绝" 1 "$rel" deploy v0.2.0
GATE_TOKEN="" expect "标准输入没给令牌：拒绝（环境里 export 的不算，失败即关闭）" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
echo "$LAST_OUT" | grep -q '没读到只读令牌' && ok "说明没读到令牌" || bad "输出不对：$LAST_OUT"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "缺令牌时没有切走" || bad "缺令牌却切走了"
# 本地 --hotfix 不再跳过闸门（#352 M3）：豁免只认 GitHub 上 PR 的 hotfix 标签（merge-gate.py 判定）
expect "本地 --hotfix 被拒绝，不跳过闸门" 1 "$rel" deploy v0.2.0 --confirm v0.2.0 --hotfix
echo "$LAST_OUT" | grep -q 'hotfix 标签' && ok "说明豁免只认 GitHub 上的 hotfix 标签" || bad "输出不对：$LAST_OUT"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "--hotfix 时没有切走" || bad "--hotfix 却切走了"
# 闸门的解释器和仓库不能用环境变量换（#352 N1）：设了 RELEASE_PYTHON=true、RELEASE_GATE_REPO 指向别的仓库，闸门照样跑、照样拒绝
rm -f "$root/gate.env"
RELEASE_PYTHON=true RELEASE_GATE_REPO=someone/no-pending-prs expect "设 RELEASE_PYTHON/RELEASE_GATE_REPO 也绕不过闸门" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
grep -qx 'REPO=uniwof/Aroomo-Developer' "$root/gate.env" 2>/dev/null && ok "闸门照样由 python3 跑、收到的仍是写死的仓库" || bad "闸门没跑或仓库不对：$(cat "$root/gate.env" 2>/dev/null)"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "设了这两个变量也没有切走" || bad "设了变量却切走了"
# 远端地址的 owner/repo 和写死的仓库不一致：拒绝，闸门都不跑（闸门本可通过，确认是核对挡住的）
mkdir -p "$work/gh/someone"; ln -s "$origin" "$work/gh/someone/Other.git"
git -C "$root" remote set-url origin "$work/gh/someone/Other.git"
rm -f "$root/GATE_FAIL" "$root/gate.env"
expect "远端仓库和闸门写死的仓库不一致：拒绝部署" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
echo "$LAST_OUT" | grep -q 'someone/Other.*不一致' && ok "说明远端仓库不一致" || bad "输出不对：$LAST_OUT"
[ ! -e "$root/gate.env" ] && ok "不一致时闸门没跑" || bad "不一致却跑了闸门"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "不一致时没有切走" || bad "不一致却切走了"
git -C "$root" remote set-url origin "$origin"; touch "$root/GATE_FAIL"

# 生产前检查：目标版本里没有 → 拒绝；有但失败 → 拒绝；演练带 --no-backup，真切换不带
# 数据库只执行到 0001，让下面两条真正走到闸门/生产前检查（否则会先被迁移核对拒绝）
printf '0001_a.sql\n' >"$applied"
expect "目标版本（v0.1.0）没有 scripts/ci/merge-gate.py：拒绝部署" 1 "$rel" deploy v0.1.0 --confirm v0.1.0
echo "$LAST_OUT" | grep -q 'merge-gate.py' && ok "说明缺合并闸门" || bad "输出不对：$LAST_OUT"
RELEASE_REQUIRE_GATE=0 RELEASE_REQUIRE_PRECHECK=1 expect "目标版本（v0.1.0）没有 release-precheck.sh：拒绝部署" 1 "$rel" deploy v0.1.0 --confirm v0.1.0
echo "$LAST_OUT" | grep -q 'release-precheck.sh' && ok "说明缺生产前检查" || bad "输出不对：$LAST_OUT"
printf '0001_a.sql\n0002_b.sql\n' >"$applied"

rm -f "$root/GATE_FAIL"
expect "闸门通过后切到 v0.2.0" 0 "$rel" deploy v0.2.0 --confirm v0.2.0
[ "$(head_tag)" = v0.2.0 ] && ok "现在是 v0.2.0" || bad "检出：$(head_tag)"

# 部署比当前已部署标签旧的版本：演练、确认都拒绝，提示改用 rollback（#352 M4）
expect "deploy 比当前（v0.2.0）旧的 v0.1.0：演练就拒绝" 1 "$rel" deploy v0.1.0
echo "$LAST_OUT" | grep -q '比当前已部署的 v0.2.0 旧' && echo "$LAST_OUT" | grep -q 'rollback' && ok "说明比当前旧、改用 rollback" || bad "输出不对：$LAST_OUT"
expect "deploy 比当前旧的 v0.1.0：确认也拒绝" 1 "$rel" deploy v0.1.0 --confirm v0.1.0
[ "$(head_tag)" = v0.2.0 ] && ok "拒绝后仍是 v0.2.0" || bad "检出变了：$(head_tag)"
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

# 迁移记录表不存在（schema 不对或连错库）：不能当成「没迁移过」，部署和回滚都拒绝
cat >"$work/db-notable.sh" <<'D'
#!/usr/bin/env bash
q="$(cat)"; case "$q" in *to_regclass*) echo "" ;; *) echo 0001_a.sql ;; esac
D
chmod +x "$work/db-notable.sh"
RELEASE_DB_CMD="$work/db-notable.sh" expect "迁移记录表不存在：拒绝部署" 1 "$rel" deploy v0.3.0
echo "$LAST_OUT" | grep -q '需要人工处理' && ok "迁移记录表不存在时写明需要人工处理" || bad "输出不对：$LAST_OUT"
RELEASE_DB_CMD="$work/db-notable.sh" expect "迁移记录表不存在：拒绝回滚" 1 "$rel" rollback
RELEASE_DB_CMD="$work/db-notable.sh" expect "迁移记录表不存在：确认回滚也拒绝" 1 "$rel" rollback --confirm "$(cat "$root/.release/previous")"
[ "$(head_tag)" = v0.2.0 ] && ok "迁移记录表不存在时代码没动" || bad "检出变了：$(head_tag)"

# ---------------------------------------------------------------------------
# 回退目标写死 SHELL_AUTH: lobe-session（生产 v0.1.0 的情况）：没配叠加文件就拒绝；配了就叠加、不重建被钉住的镜像
printf '0001_a.sql\n0002_b.sql\n0003_c.sql\n' >"$applied"
git -C "$seed" checkout -q main
rm -f "$seed/FAIL_UP"
printf 'services:\n  shell:\n    environment:\n      SHELL_AUTH: lobe-session\n' >"$seed/deploy/docker-compose.yml"
# 生产前检查桩：记下目标版本的迁移目录有没有一起取出来
cat >"$seed/scripts/release-precheck.sh" <<'G'
#!/usr/bin/env bash
ls "$(dirname "$0")/../core/migrations" >"${RELEASE_ROOT:?}/precheck.migs" 2>&1 || true
[ -z "${GH_TOKEN:-}" ] || echo "precheck(v0.4.0) 拿到了 GH_TOKEN" >>"${RELEASE_TEST_CALLS:?}.leak"
exit 0
G
commit "Shell 写死 lobe-session"; git -C "$seed" tag v0.4.0
# shellcheck disable=SC2016  # 写进 compose 文件的就是字面量 ${…}
printf 'services:\n  shell:\n    environment:\n      SHELL_AUTH: ${SHELL_AUTH:-core-session}\n' >"$seed/deploy/docker-compose.yml"
commit "Shell 默认 core-session"; git -C "$seed" tag v0.5.0
git -C "$seed" push -q "$origin" main --tags
expect "切到 v0.4.0（自动回退目标 v0.2.0 没有 compose，不受影响）" 0 "$rel" deploy v0.4.0 --confirm v0.4.0
[ "$(head_tag)" = v0.4.0 ] && ok "现在是 v0.4.0" || bad "检出不对：$(head_tag)"
grep -qx '0003_c.sql' "$root/precheck.migs" && ok "precheck 拿到了目标版本的 core/migrations/" || bad "precheck 没拿到迁移目录：$(cat "$root/precheck.migs")"

expect "部署 v0.5.0：自动回退目标 v0.4.0 写死 lobe-session、没配叠加文件 → 演练就拒绝" 1 "$rel" deploy v0.5.0
echo "$LAST_OUT" | grep -q '所有者会进不去' && ok "拒绝理由写明所有者会进不去" || bad "拒绝理由不对：$LAST_OUT"
expect "--lobe-session-ok 明确要旧登录时放行" 0 "$rel" deploy v0.5.0 --lobe-session-ok
mkdir -p "$root/.release/compose-extra"
ovr="$work/overrides/prod-shell-core-auth.yml"
printf '# 回到 v0.4.0 时叠加 core-session 的 Shell\n%s\nnobuild: shell\n' "$ovr" >"$root/.release/compose-extra/v0.4.0"
expect "叠加文件列了但不存在 → 拒绝" 1 "$rel" deploy v0.5.0
echo "$LAST_OUT" | grep -q '叠加文件不存在' && ok "写明叠加文件不存在" || bad "输出不对：$LAST_OUT"
mkdir -p "$work/overrides"; printf 'services:\n  shell:\n    image: aroomo-shell:core-auth-x\n' >"$ovr"
expect "配好叠加文件后演练通过" 0 "$rel" deploy v0.5.0
echo "$LAST_OUT" | grep -q "会叠加：$ovr" && ok "演练写明回退时会叠加哪个文件" || bad "输出不对：$LAST_OUT"
docker_calls="$work/docker.calls"; : >"$docker_calls"
# shellcheck disable=SC2016  # 桩脚本里的 $* / ${GH_TOKEN} 就是字面量
printf '#!/usr/bin/env bash\necho "$*" >>"%s"\n[ -z "${GH_TOKEN:-}" ] || echo "docker 拿到了 GH_TOKEN" >>"%s.leak"\nexit 0\n' "$docker_calls" "$RELEASE_TEST_CALLS" >"$work/docker.sh"; chmod +x "$work/docker.sh"
export RELEASE_DOCKER="$work/docker.sh"
expect "切到 v0.5.0" 0 "$rel" deploy v0.5.0 --confirm v0.5.0
[ ! -s "$docker_calls" ] && ok "没有叠加文件的版本照常走 compose.sh" || bad "v0.5.0 却直接调了 docker：$(cat "$docker_calls")"

mv "$root/.release/compose-extra/v0.4.0" "$work/extra.bak"
expect "回滚到写死 lobe-session 的 v0.4.0、没配叠加文件 → 拒绝" 1 "$rel" rollback
expect "确认回滚也拒绝" 1 "$rel" rollback --confirm v0.4.0
[ "$(head_tag)" = v0.5.0 ] && ok "拒绝后仍是 v0.5.0" || bad "检出变了：$(head_tag)"
mv "$work/extra.bak" "$root/.release/compose-extra/v0.4.0"
expect "回滚演练：写明会叠加" 0 "$rel" rollback
echo "$LAST_OUT" | grep -q "回滚到 v0.4.0 时会叠加：$ovr" && ok "回滚演练写明叠加文件" || bad "输出不对：$LAST_OUT"
: >"$docker_calls"
expect "回滚到 v0.4.0（叠加 core-session 的 Shell）" 0 "$rel" rollback --confirm v0.4.0
[ "$(head_tag)" = v0.4.0 ] && ok "回滚后是 v0.4.0" || bad "检出不对：$(head_tag)"
grep -q -- "-f $ovr build core\$" "$docker_calls" && ok "叠加文件参与构建，只重建 core" || bad "构建调用不对：$(cat "$docker_calls")"
grep -q 'build.*shell' "$docker_calls" && bad "重建了被钉住的 shell 镜像" || ok "没有重建 shell（不覆盖钉住的镜像）"
grep -q -- "-f $ovr up -d --remove-orphans --no-build\$" "$docker_calls" && ok "up 带叠加文件且 --no-build" || bad "up 调用不对：$(cat "$docker_calls")"
grep -q -- "--project-directory $root/deploy -f $root/deploy/docker-compose.yml -f $root/deploy/tiers/standard.yml" "$docker_calls" && ok "和 compose.sh 用同一组基础文件" || bad "基础文件不对：$(cat "$docker_calls")"
unset RELEASE_DOCKER

# ---------------------------------------------------------------------------
# 回滚目标必须在 origin/main 上（#353）：只查本地 ref，不联网
printf '0001_a.sql\n0002_b.sql\n0003_c.sql\n' >"$applied"
printf '%s\n' "$(git -C "$seed" rev-parse v0.9.0)" >"$root/.release/previous"
expect "回滚目标在 dev 上（不在 origin/main）：演练拒绝" 1 "$rel" rollback
echo "$LAST_OUT" | grep -q '不在 origin/main 上' && ok "说明回滚目标不在 main 上" || bad "输出不对：$LAST_OUT"
expect "回滚目标在 dev 上：确认也拒绝" 1 "$rel" rollback --confirm "$(git -C "$seed" rev-parse --short=7 v0.9.0)"
[ "$(head_tag)" = v0.4.0 ] && ok "拒绝后仍是 v0.4.0" || bad "检出变了：$(head_tag)"
printf 'v0.5.0\n' >"$root/.release/previous"
git -C "$root" remote set-url origin "$work/gh/does-not-exist.git"
expect "远端连不上时回滚演练照样通过（只查本地 origin/main）" 0 rel_notok rollback
git -C "$root" remote set-url origin "$origin"

# 第一次从提交号切到标签（#353）：目标比当前提交旧就拒绝；同一个提交或更新的照常
rm -f "$root/.release/current" "$root/.release/previous"
git -C "$root" checkout -q -f "$(git -C "$seed" rev-parse v0.5.0)"
expect "当前是提交号（v0.5.0 的提交），deploy 更旧的 v0.4.0：演练拒绝" 1 "$rel" deploy v0.4.0
echo "$LAST_OUT" | grep -q '比当前提交 .* 旧' && echo "$LAST_OUT" | grep -q rollback && ok "说明比当前提交旧、改用 rollback" || bad "输出不对：$LAST_OUT"
expect "当前是提交号，deploy 更旧的 v0.4.0：确认也拒绝" 1 "$rel" deploy v0.4.0 --confirm v0.4.0
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.5.0)" ] && ok "拒绝后没切走" || bad "拒绝却切走了"
expect "当前是提交号，deploy 同一个提交上的 v0.5.0：演练通过" 0 "$rel" deploy v0.5.0
git -C "$root" checkout -q -f "$(git -C "$seed" rev-parse v0.4.0)"
expect "当前是提交号（v0.4.0 的提交），deploy 更新的 v0.5.0：演练通过" 0 "$rel" deploy v0.5.0 --lobe-session-ok
printf 'v0.4.0\n' >"$root/.release/current"; printf 'v0.5.0\n' >"$root/.release/previous"   # 还原状态

# ---------------------------------------------------------------------------
# 测试开关只在 RELEASE_TEST_MODE=1 时生效（#353）：不设测试模式时，设了任何一个就拒绝，什么都不动
knobs=(RELEASE_REMOTE RELEASE_MAIN_BRANCH RELEASE_DB_CMD RELEASE_HEALTH_CMD RELEASE_REQUIRE_GATE
  RELEASE_REQUIRE_PRECHECK RELEASE_DOCKER RELEASE_SKIP_CONSOLE
  RELEASE_PSQL RELEASE_BACKUP_CMD RELEASE_SNAPSHOTS_CMD RELEASE_DOCKER_NETS_CMD RELEASE_IP_ROUTE_CMD
  RELEASE_MCP_NET_NAME RELEASE_MIGRATIONS_DIR)
unset_args=(-u RELEASE_TEST_MODE); for k in "${knobs[@]}"; do unset_args+=(-u "$k"); done
prodlike() { env "${unset_args[@]}" "$@" "$relbin" "${PRODLIKE_ARGS[@]}" </dev/null; }   # 用法：prodlike [VAR=值…]
head_before="$(git -C "$root" rev-parse HEAD)"; cur_before="$(cat "$root/.release/current")"
hist_before="$(wc -l <"$root/.release/history.log")"
declare -A knob_val=([RELEASE_REMOTE]=evil [RELEASE_MAIN_BRANCH]=dev [RELEASE_DB_CMD]="$dbcmd" [RELEASE_HEALTH_CMD]="$health"
  [RELEASE_REQUIRE_GATE]=0 [RELEASE_REQUIRE_PRECHECK]=0 [RELEASE_DOCKER]=true [RELEASE_SKIP_CONSOLE]=1
  [RELEASE_PSQL]=true [RELEASE_BACKUP_CMD]=true [RELEASE_SNAPSHOTS_CMD]=true [RELEASE_DOCKER_NETS_CMD]=true
  [RELEASE_IP_ROUTE_CMD]=true [RELEASE_MCP_NET_NAME]=x [RELEASE_MIGRATIONS_DIR]=/tmp)
rm -f "$root/gate.env"
for k in "${knobs[@]}"; do
  PRODLIKE_ARGS=(deploy v0.5.0 --confirm v0.5.0)
  expect "非测试模式：设了 $k 就拒绝" 1 prodlike "$k=${knob_val[$k]}"
  echo "$LAST_OUT" | grep -q "测试开关.*$k" || bad "$k 的拒绝理由不对：$LAST_OUT"
done
PRODLIKE_ARGS=(rollback --confirm v0.5.0)
expect "非测试模式：rollback 设 RELEASE_DB_CMD 也拒绝" 1 prodlike RELEASE_DB_CMD="$dbcmd"
PRODLIKE_ARGS=(list)
expect "非测试模式：list 设 RELEASE_MAIN_BRANCH=dev 也拒绝" 1 prodlike RELEASE_MAIN_BRANCH=dev
PRODLIKE_ARGS=(deploy v0.5.0)
expect "非测试模式：同时设多个都列出来" 1 prodlike RELEASE_REQUIRE_GATE=0 RELEASE_REQUIRE_PRECHECK=0
echo "$LAST_OUT" | grep -q 'RELEASE_REQUIRE_GATE RELEASE_REQUIRE_PRECHECK' && ok "列出全部设了的开关" || bad "输出不对：$LAST_OUT"
[ "$(git -C "$root" rev-parse HEAD)" = "$head_before" ] && [ "$(cat "$root/.release/current")" = "$cur_before" ] \
  && ok "被拒时检出和 current 都没动" || bad "被拒却改了检出或 current"
[ ! -e "$root/gate.env" ] && ok "被拒时闸门没跑" || bad "被拒却跑了闸门"
[ "$(wc -l <"$root/.release/history.log")" = "$hist_before" ] && ok "被拒发生在任何动作之前（history.log 没新行）" || bad "被拒前已经写了日志"
PRODLIKE_ARGS=(deploy v0.5.0)
expect "RELEASE_TEST_MODE 只认 1：设成 yes 拒绝" 1 prodlike RELEASE_TEST_MODE=yes
# 设成空串的开关不算设了，但同样不生效：下面走的是默认 compose 里的 psql（桩没有输出 → 读不出迁移记录 → 拒绝）
: >"$RELEASE_TEST_CALLS"
PRODLIKE_ARGS=(deploy v0.5.0)
expect "非测试模式不设开关：迁移核对走默认的 compose psql（不是 RELEASE_DB_CMD）" 1 prodlike RELEASE_DB_CMD=
echo "$LAST_OUT" | grep -q '读不出数据库的迁移记录' && grep -q 'exec -T -e PGOPTIONS=-c default_transaction_read_only=on postgres psql' "$RELEASE_TEST_CALLS" \
  && ok "用的是只读 psql 默认值" || bad "没走默认 psql：$LAST_OUT / $(cat "$RELEASE_TEST_CALLS")"
PRODLIKE_ARGS=(list)
expect "非测试模式不设开关：list 用默认 origin/main" 0 prodlike
echo "$LAST_OUT" | grep -q 'v0.5.0' && ! echo "$LAST_OUT" | grep -q 'v0.9.0' && ok "默认只认 origin/main 上的标签" || bad "list 不对：$LAST_OUT"

# 生产目录（/opt/aroomo，含默认值、多余的 /、..、软链接）禁用测试模式：直接拒绝，不在生产目录写任何东西
opt_existed=0; [ -e /opt/aroomo ] && opt_existed=1
for r in /opt/aroomo /opt/aroomo/ /opt/./aroomo /opt/x/../aroomo; do
  RELEASE_ROOT="$r" expect "生产目录 $r 上 RELEASE_TEST_MODE=1 被拒" 1 "$relbin" status
  echo "$LAST_OUT" | grep -q '生产目录.*禁用测试模式' || bad "$r 的拒绝理由不对：$LAST_OUT"
done
ln -s /opt/aroomo "$work/prod-link"
RELEASE_ROOT="$work/prod-link" expect "指向 /opt/aroomo 的软链接上 RELEASE_TEST_MODE=1 被拒" 1 "$relbin" status
env -u RELEASE_ROOT RELEASE_TEST_MODE=1 "$relbin" status >"$work/out" 2>&1 && bad "默认目录（/opt/aroomo）上测试模式却没被拒" \
  || { grep -q '禁用测试模式' "$work/out" && ok "不设 RELEASE_ROOT（默认生产目录）时测试模式被拒" || bad "输出不对：$(cat "$work/out")"; }
PRODLIKE_ARGS=(deploy v0.5.0)
expect "生产目录上不设测试模式、设了 RELEASE_REQUIRE_GATE=0 也拒绝" 1 prodlike RELEASE_ROOT=/opt/aroomo RELEASE_REQUIRE_GATE=0
[ "$opt_existed" = 1 ] || { [ ! -e /opt/aroomo ] && ok "被拒时没有建 /opt/aroomo" || bad "被拒却建了 /opt/aroomo"; }

# compose 输出写进 600 权限的日志文件，不再丢掉
[ "$(stat -c %a "$root/.release/compose.log")" = 600 ] && ok "compose.log 权限 600" || bad "compose.log 权限不对"

if grep -rn 'AGE-SECRET-KEY\|CORE_CHAT_TOKEN=abc' "$root/.release" >/dev/null 2>&1; then bad "状态/日志里出现了密钥"; else ok "日志无密钥"; fi
if grep -rnF -e "$GH_TOKEN" -e "$GATE_TOKEN" "$root/.release" "$root/gate.env" >/dev/null 2>&1; then bad "日志/闸门记录里出现了令牌"; else ok "日志无令牌"; fi
# 令牌只给闸门（#352 M1）：precheck、compose.sh、docker 桩执行时环境里都没有 GH_TOKEN（它们确实跑过）
[ -s "$root/precheck.args" ] && [ -s "$RELEASE_TEST_CALLS" ] && [ -s "$docker_calls" ] || bad "precheck/compose/docker 桩没跑过，下面的断言没意义"
if [ -s "$RELEASE_TEST_CALLS.leak" ]; then bad "令牌传到了闸门以外：$(sort -u "$RELEASE_TEST_CALLS.leak")"; else ok "precheck、compose、docker 都拿不到 GH_TOKEN"; fi
[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
