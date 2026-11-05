// 借用代码闸门（Ekko Studio，BSL 1.1；所有者 2026-11-05 13:00「自用阶段可以借，收费前剥离」）。
// D179 许可证闸门的唯一例外：只放行 core/src/third_party/ekko/。判定逻辑无第三方依赖，便于单测。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BORROWED_DIR = 'core/src/third_party/ekko';
export const HEADER_RE = /^\/\/ Derived from Ekko Studio \(BSL 1\.1\), source (\S+)@59530f6\b/;
const MARK_RE = /Derived from Ekko Studio|EKKOLearnAI|ekko-studio/i;
const BANNED_EXT = /\.(tsx|jsx|css|scss|sass|less|vue)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|vue|css|scss|sql|sh)$/i;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** @returns {string[]} 问题列表；空 = 通过。paidLaunch=true 时要求目录为空（收费前预检）。 */
export function checkBorrowed(root, { paidLaunch = false } = {}) {
  const problems = [];
  const dir = join(root, BORROWED_DIR);
  const inDir = existsSync(dir) ? walk(dir).map((p) => relative(dir, p).replaceAll('\\', '/')) : [];
  if (paidLaunch) {
    if (inDir.length > 0) problems.push(`${BORROWED_DIR} 必须为空才能收费上线（还有 ${inDir.length} 个文件，见 BORROWED.md）`);
    return problems;
  }
  // 1. 带 Ekko 标记的代码只准出现在借用目录里（BORROWED.md、ekko-ref 参考克隆不在仓库内）
  for (const p of walk(root)) {
    const rel = relative(root, p).replaceAll('\\', '/');
    if (rel.startsWith(`${BORROWED_DIR}/`) || !TEXT_EXT.test(rel) || rel === 'scripts/license-gate/borrowed.mjs' || rel === 'scripts/license-gate/borrowed.test.mjs') continue;
    if (MARK_RE.test(readFileSync(p, 'utf8'))) problems.push(`${rel}：含 Ekko 借用标记，借用代码只能放在 ${BORROWED_DIR}/`);
  }
  if (inDir.length === 0) return problems;
  // 2. 目录里：只准纯逻辑 .ts + BORROWED.md；每个 .ts 第一行是文件头；清单与目录一致
  const listPath = join(dir, 'BORROWED.md');
  const listed = new Set(
    existsSync(listPath)
      ? [...readFileSync(listPath, 'utf8').matchAll(/^\|\s*([\w./-]+\.ts)\s*\|/gm)].map((m) => m[1])
      : [],
  );
  if (!existsSync(listPath)) problems.push(`${BORROWED_DIR}/BORROWED.md 不存在`);
  for (const f of inDir) {
    if (f === 'BORROWED.md') continue;
    if (BANNED_EXT.test(f)) {
      problems.push(`${BORROWED_DIR}/${f}：借用目录不允许界面文件（.tsx/.css/.vue 等），界面一律按 sumus 自己做`);
      continue;
    }
    if (!f.endsWith('.ts')) {
      problems.push(`${BORROWED_DIR}/${f}：借用目录只允许 .ts 纯逻辑文件`);
      continue;
    }
    const first = readFileSync(join(dir, f), 'utf8').split('\n', 1)[0] ?? '';
    if (!HEADER_RE.test(first)) problems.push(`${BORROWED_DIR}/${f}：第一行缺少文件头「// Derived from Ekko Studio (BSL 1.1), source <原路径>@59530f6」`);
    if (!listed.has(f)) problems.push(`${BORROWED_DIR}/${f}：没登记在 BORROWED.md`);
  }
  for (const f of listed) if (!inDir.includes(f)) problems.push(`BORROWED.md 登记了 ${f}，但文件不存在`);
  return problems;
}
