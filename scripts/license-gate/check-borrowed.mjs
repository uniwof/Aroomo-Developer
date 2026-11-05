#!/usr/bin/env node
// 用法：node scripts/license-gate/check-borrowed.mjs [--paid-launch] [仓库根目录]
// 默认：CI 每次跑，检查借用目录的规矩；--paid-launch：收费前预检（#229），要求 core/src/third_party/ekko 为空。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBorrowed } from './borrowed.mjs';

const args = process.argv.slice(2);
const paidLaunch = args.includes('--paid-launch');
const rootArg = args.find((a) => !a.startsWith('--'));
const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const problems = checkBorrowed(root, { paidLaunch });
for (const p of problems) console.error(`✗ ${p}`);
if (problems.length > 0) process.exit(1);
console.log(paidLaunch ? '✓ 借用目录为空，可以收费上线' : '✓ 借用代码闸门通过（只在 core/src/third_party/ekko，已登记、带文件头、无界面文件）');
