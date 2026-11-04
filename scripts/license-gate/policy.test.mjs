// node --test scripts/license-gate/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, evaluate, packagesFromLock } from './policy.mjs';

test('白名单许可证通过', () => {
  for (const l of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'BlueOak-1.0.0', '(MIT OR Apache-2.0)', 'MIT AND ISC', 'Apache-2.0 WITH LLVM-exception']) {
    assert.equal(judge(l).ok, true, l);
  }
});

test('禁用许可证直接失败', () => {
  for (const l of ['AGPL-3.0', 'AGPL-3.0-only', 'SSPL-1.0', 'BUSL-1.1', 'MIT AND Commons-Clause', 'CC-BY-NC-4.0', 'PolyForm-Noncommercial-1.0.0', 'Elastic-2.0', 'RSALv2', 'LobeHub Community License', 'GNU Affero General Public License v3', 'Server Side Public License']) {
    assert.deepEqual(judge(l), { ok: false, reason: 'denied' }, l);
  }
});

test('OR 有一个可用就通过；全被禁才是禁用', () => {
  assert.equal(judge('AGPL-3.0 OR MIT').ok, true);
  assert.equal(judge('(SSPL-1.0 OR BUSL-1.1)').reason, 'denied');
});

test('BSL-1.0（Boost）不是 BUSL', () => {
  assert.equal(judge('BSL-1.0').ok, true);
});

test('未知或缺失需登记', () => {
  for (const l of ['', 'UNLICENSED', 'SEE LICENSE IN LICENSE', 'GPL-3.0', 'Custom']) {
    assert.equal(judge(l).reason, 'unknown', l);
  }
});

test('登记例外只对未知生效，对禁用无效，且许可证须一致', () => {
  const pkgs = [
    { name: 'a', version: '1', license: 'Custom' },
    { name: 'b', version: '1', license: 'AGPL-3.0' },
    { name: 'c', version: '1', license: 'GPL-3.0' },
  ];
  const allow = {
    a: { license: 'Custom', reason: '作者书面允许商用' },
    b: { license: 'AGPL-3.0', reason: '试图绕过' },
    c: { license: 'GPL-2.0', reason: '许可证对不上' },
  };
  assert.deepEqual(evaluate(pkgs, allow).map((x) => x.name), ['b', 'c']);
});

test('lockfile 解析：跳过根包和 link，取嵌套包名', () => {
  const pkgs = packagesFromLock({
    packages: {
      '': { name: 'root', license: 'UNLICENSED' },
      'node_modules/x': { version: '1.0.0', license: 'MIT' },
      'node_modules/x/node_modules/@s/y': { version: '2.0.0', license: { type: 'ISC' } },
      'node_modules/z': { link: true },
    },
  });
  assert.deepEqual(pkgs.map((p) => [p.name, p.license]), [['x', 'MIT'], ['@s/y', 'ISC']]);
});
