#!/usr/bin/env node
// D179 npm 许可证闸门：扫描仓库内所有 package-lock.json（含 devDependencies，构建工具也会被分发进镜像或安装包）。
// 用法：node scripts/license-gate/check-npm.mjs [仓库根目录]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagesFromLock, evaluate } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, '..', '..'));
const allowPath = join(here, 'allow.json');
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')).npm ?? {} : {};

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out']);
function findLocks(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findLocks(p, acc);
    else if (name === 'package-lock.json') acc.push(p);
  }
  return acc;
}

const locks = findLocks(root);
let total = 0;
let failed = 0;
for (const lockPath of locks) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if ((lock.lockfileVersion ?? 1) < 2) {
    console.error(`✗ ${relative(root, lockPath)}: lockfileVersion < 2，无法读取许可证，请用 npm ≥ 7 重新生成`);
    failed++;
    continue;
  }
  const pkgs = packagesFromLock(lock);
  total += pkgs.length;
  const bad = evaluate(pkgs, allow);
  for (const b of bad) {
    const why = b.reason === 'denied' ? '禁用许可证（D179）' : '未在白名单，需在 scripts/license-gate/allow.json 登记理由';
    console.error(`✗ ${relative(root, lockPath)}: ${b.name}@${b.version} 许可证「${b.license || '缺失'}」— ${why}`);
  }
  failed += bad.length;
  console.log(`${bad.length ? '✗' : '✓'} ${relative(root, lockPath)}: ${pkgs.length} 个包`);
}
if (locks.length === 0) console.log('未找到 package-lock.json');
if (failed) {
  console.error(`许可证闸门失败：${failed} 项`);
  process.exit(1);
}
console.log(`许可证闸门通过：${locks.length} 个 lockfile，共 ${total} 个包`);
