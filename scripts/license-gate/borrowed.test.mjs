import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BORROWED_DIR, checkBorrowed } from './borrowed.mjs';

const HEAD = '// Derived from Ekko Studio (BSL 1.1), source packages/x.ts@59530f6 — strip before paid launch\n';
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'borrowed-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
const ok = (extra = {}) => ({ [`${BORROWED_DIR}/a.ts`]: `${HEAD}export const a = 1\n`, [`${BORROWED_DIR}/BORROWED.md`]: '| a.ts | packages/x.ts | 抄 |\n', ...extra });

test('合规的借用目录通过', () => assert.deepEqual(checkBorrowed(repo(ok())), []));
test('目录为空也通过；--paid-launch 时空目录通过', () => {
  assert.deepEqual(checkBorrowed(repo({ 'core/src/x.ts': 'export {}\n' })), []);
  assert.deepEqual(checkBorrowed(repo({ 'core/src/x.ts': 'export {}\n' }), { paidLaunch: true }), []);
});
test('--paid-launch：目录里还有文件就失败', () => assert.match(checkBorrowed(repo(ok()), { paidLaunch: true })[0], /必须为空/));
test('拒绝 .tsx / .css / .vue', () => {
  for (const f of ['b.tsx', 'c.css', 'd.vue']) {
    const out = checkBorrowed(repo(ok({ [`${BORROWED_DIR}/${f}`]: HEAD })));
    assert.ok(out.some((p) => p.includes(f) && p.includes('界面文件')), out.join('\n'));
  }
});
test('缺文件头、没登记、登记了却不存在都失败', () => {
  assert.ok(checkBorrowed(repo(ok({ [`${BORROWED_DIR}/a.ts`]: 'export const a = 1\n' }))).some((p) => p.includes('文件头')));
  assert.ok(checkBorrowed(repo(ok({ [`${BORROWED_DIR}/b.ts`]: HEAD }))).some((p) => p.includes('没登记')));
  assert.ok(checkBorrowed(repo(ok({ [`${BORROWED_DIR}/BORROWED.md`]: '| a.ts | x |\n| gone.ts | y |\n' }))).some((p) => p.includes('gone.ts')));
});
test('带 Ekko 文件头的代码出现在借用目录以外 → 失败', () => {
  const out = checkBorrowed(repo(ok({ 'core/src/router/x.ts': HEAD })));
  assert.ok(out.some((p) => p.startsWith('core/src/router/x.ts')), out.join('\n'));
});
