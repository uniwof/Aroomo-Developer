#!/usr/bin/env node
// 读 pip-licenses --format=json 的输出，按 policy.mjs 判定。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [file, label = file] = process.argv.slice(2);
const allowPath = join(here, 'allow.json');
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')).python ?? {} : {};

// pip-licenses 的 License 字段是分号分隔的分类器名或元数据，如 "MIT License; Apache Software License"
const CLASSIFIER = {
  'MIT License': 'MIT', MIT: 'MIT', 'BSD License': 'BSD-3-Clause', BSD: 'BSD-3-Clause',
  'Apache Software License': 'Apache-2.0', 'Apache 2.0': 'Apache-2.0', 'Apache License 2.0': 'Apache-2.0',
  'ISC License (ISCL)': 'ISC', 'Python Software Foundation License': 'PSF-2.0',
  'Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0', 'The Unlicense (Unlicense)': 'Unlicense',
};
const rows = JSON.parse(readFileSync(file, 'utf8'));
const pkgs = rows.map((r) => {
  const raw = String(r.License ?? '').split(/;\s*/).filter(Boolean);
  const mapped = raw.map((x) => CLASSIFIER[x.trim()] ?? x.trim());
  return { name: r.Name, version: r.Version, license: mapped.join(' OR ') };
});
const bad = evaluate(pkgs, allow);
for (const b of bad) {
  const why = b.reason === 'denied' ? '禁用许可证（D179）' : '未在白名单，需在 scripts/license-gate/allow.json 登记理由';
  console.error(`✗ ${label}: ${b.name}==${b.version} 许可证「${b.license || '缺失'}」— ${why}`);
}
console.log(`${bad.length ? '✗' : '✓'} ${label}: ${pkgs.length} 个包`);
process.exit(bad.length ? 1 : 0);
