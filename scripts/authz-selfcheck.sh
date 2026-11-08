#!/usr/bin/env bash
# 越权测试自证（#176，#335 必改 4）：把 core/test/authz/self-check/ 里两个「故意改坏 src」的补丁逐个打上，
# 跑跨账号越权测试，断言被抓到（而且是被预期的那项检查抓到），再还原。证明测试不是「怎么改都绿」。
#
#   library-get-cross-read.patch     GET /api/library/:id 找不到时退回所有者范围读 → 越权读
#                                    预期：每个存储都被「遍历全部路由」抓到（严格 404 / 泄露检查）
#   interrupt-budget-cross-write.patch PUT /api/interrupt-budget 顺手写进所有者的设置 → 越权写，响应照常 200
#                                    预期：pglite-app-role 和 postgres-app-role 都被「数据库快照」抓到（core_settings 变了）。
#                                    内存存储没有表可查，快照退回「受害者把读接口读一遍」：这个改坏目前碰巧也能被读接口看出来，
#                                    但那不是数据库快照，换个读接口不回显的写法就抓不到，所以不作要求（已知局限，只打印）。
#
# 真 PG：设 CORE_TEST_DATABASE_URL 才跑；CI（CI=true）或 AROOMO_REQUIRE_REAL_PG=1 时没设就失败。
# 用法：scripts/authz-selfcheck.sh        （要求 core/src 没有未提交的改动；退出时一定还原补丁）
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
DIR=core/test/authz/self-check
REQUIRE_PG=0
if [[ "${CI:-}" == "true" || "${CI:-}" == "1" || "${AROOMO_REQUIRE_REAL_PG:-}" == "1" ]]; then REQUIRE_PG=1; fi
if [[ -z "${CORE_TEST_DATABASE_URL:-}" && $REQUIRE_PG == 1 ]]; then
  echo "失败：CI 里必须设 CORE_TEST_DATABASE_URL（真 PG 那条路径要证明也抓得到）" >&2
  exit 1
fi
if ! git diff --quiet -- core/src || ! git diff --cached --quiet -- core/src; then
  echo "失败：core/src 有未提交的改动，先提交或收起来再跑（脚本要在干净的 src 上打补丁、再原样还原）" >&2
  exit 1
fi

applied=""
restore() {
  if [[ -n "$applied" ]]; then git apply -R "$applied" && echo "已还原 $applied"; applied=""; fi
}
trap restore EXIT INT TERM

TEST="遍历全部路由"
run_case() { # $1 补丁  $2 必须抓到的存储（空格分隔）  $3 失败信息里必须有的文字（正则）  $4 只打印不要求的存储
  local patch=$DIR/$1 out
  out=$(mktemp)
  git apply --check "$patch"
  git apply "$patch"
  applied=$patch
  echo "== 打上 $1，跑越权测试 =="
  (cd core && npx vitest run test/authz/cross-account.test.ts --reporter=json --outputFile="$out" >/dev/null 2>&1) || true
  restore
  node - "$out" "$TEST" "$2" "$3" "$4" "${CORE_TEST_DATABASE_URL:+1}" <<'JS'
const [file, test, must, pattern, info, hasPg] = process.argv.slice(2);
const r = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
const all = r.testResults.flatMap((f) => f.assertionResults);
const re = new RegExp(pattern);
let bad = 0;
const result = (env) => all.find((a) => a.fullName.includes(`[${env}]`) && a.title.includes(test));
for (const env of must.split(' ').filter(Boolean)) {
  if (env === 'postgres-app-role' && !hasPg) { console.log(`  跳过 ${env}：本地没设 CORE_TEST_DATABASE_URL（CI 里必跑）`); continue; }
  const a = result(env);
  if (!a) { console.log(`  失败 ${env}：没找到「${test}」用例（没跑？）`); bad++; continue; }
  const msg = a.failureMessages.join('\n');
  if (a.status !== 'failed') { console.log(`  失败 ${env}：改坏以后测试还是绿的——没抓到`); bad++; }
  else if (!re.test(msg)) { console.log(`  失败 ${env}：红了，但不是被预期的检查抓到（应匹配 /${pattern}/）：\n${msg.slice(0, 600)}`); bad++; }
  else console.log(`  抓到 ${env}：${msg.split('\n')[0].slice(0, 160)}`);
}
for (const env of info.split(' ').filter(Boolean)) {
  const a = result(env);
  console.log(`  （仅记录）${env}：${a ? (a.status === 'failed' ? '抓到 — ' + a.failureMessages.join('\n').split('\n')[0].slice(0, 120) : '没抓到（已知局限）') : '没跑'}`);
}
process.exit(bad ? 1 : 0);
JS
  rm -f "$out"
}

run_case library-get-cross-read.patch "memory pglite-app-role postgres-app-role" "状态码和声明的期望不一致|泄露|看出别人的资源存在" ""
run_case interrupt-budget-cross-write.patch "pglite-app-role postgres-app-role" "数据库快照[^\\n]*core_settings" "memory"
echo "自证通过：两个故意改坏都被抓到，src 已还原"
