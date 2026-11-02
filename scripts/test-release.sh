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
echo one >"$seed/a.txt"; commit "第一版"; git -C "$seed" tag v0.1.0
echo two >"$seed/a.txt"; commit "第二版"; git -C "$seed" tag v0.2.0
touch "$seed/FAIL_UP"; commit "坏版本（up 会失败）"; git -C "$seed" tag v0.3.0
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
export RELEASE_HEALTH_TIMEOUT_S=2
health="$work/health.sh"
cat >"$health" <<'H'
#!/usr/bin/env bash
cd "$RELEASE_ROOT"; if [ -f FAIL_UP ]; then echo unhealthy; else echo healthy; fi
H
chmod +x "$health"; export RELEASE_HEALTH_CMD="$health"
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

expect "切到坏版本 v0.3.0 失败并自动回到 v0.2.0" 1 "$rel" deploy v0.3.0 --confirm v0.3.0
[ "$(head_tag)" = v0.2.0 ] && ok "失败后回到 v0.2.0" || bad "失败后检出：$(head_tag)"
[ "$(cat "$root/.release/current")" = v0.2.0 ] && ok "失败后 current 仍是 v0.2.0" || bad "失败后 current 变了"

expect "回滚演练" 0 "$rel" rollback
expect "一键回滚到上一个（v0.1.0 之前的记录是 v0.1.0 的提交）" 0 "$rel" rollback --confirm "$(cat "$root/.release/previous")"
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "回滚后是 v0.1.0 的提交" || bad "回滚后检出不对"
[ "$(cat "$root/.release/previous")" = v0.2.0 ] && ok "回滚后 previous=v0.2.0（可再切回）" || bad "previous 状态不对"

# 没有 .env 必需项时拒绝（不自动生成）
sed -i '/^CORE_CHAT_TOKEN=/d' "$root/deploy/.env"
expect "缺 CORE_CHAT_TOKEN 时切换失败并回退" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
[ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$seed" rev-parse v0.1.0)" ] && ok "缺 token 时没有切走" || bad "缺 token 却切走了"
grep -q '^CORE_CHAT_TOKEN=' "$root/deploy/.env" && bad "脚本自动生成了 token" || ok "不自动生成 token"

# 合并闸门：存在且失败时拒绝；hotfix 跳过
echo "CORE_CHAT_TOKEN=abc" >>"$root/deploy/.env"
printf '#!/usr/bin/env bash\nexit 1\n' >"$root/scripts/merge-gate.sh"; chmod +x "$root/scripts/merge-gate.sh"
expect "合并闸门不过则拒绝" 1 "$rel" deploy v0.2.0 --confirm v0.2.0
expect "hotfix 跳过闸门" 0 "$rel" deploy v0.2.0 --confirm v0.2.0 --hotfix
rm -f "$root/scripts/merge-gate.sh"

# 生产前检查脚本存在且失败时拒绝部署
printf '#!/usr/bin/env bash\nexit 1\n' >"$root/scripts/release-precheck.sh"; chmod +x "$root/scripts/release-precheck.sh"
expect "生产前检查失败则不切换" 1 "$rel" deploy v0.1.0 --confirm v0.1.0
[ "$(head_tag)" = v0.2.0 ] && ok "检查失败后仍是 v0.2.0" || bad "检查失败却切换了"

if grep -rn 'AGE-SECRET-KEY\|CORE_CHAT_TOKEN=abc' "$root/.release" >/dev/null 2>&1; then bad "状态/日志里出现了密钥"; else ok "日志无密钥"; fi
[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
