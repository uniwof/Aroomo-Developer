#!/usr/bin/env node
// 自动从 npm/Python 依赖生成 docs/third-party.md 中的代码依赖清单。
// 用法：
//   node scripts/generate-third-party.mjs          # 更新 docs/third-party.md
//   node scripts/generate-third-party.mjs --check  # 检查 docs/third-party.md 是否与依赖一致（用于 CI）

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { packagesFromLock } from './license-gate/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(here, '..'));
const targetDocPath = join(root, 'docs', 'third-party.md');
const isCheck = process.argv.includes('--check');

const MARKER_START = '<!-- AUTO-GENERATED-DEPENDENCIES-START -->';
const MARKER_END = '<!-- AUTO-GENERATED-DEPENDENCIES-END -->';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'tmp']);

function findFiles(dir, filenamePattern, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      findFiles(p, filenamePattern, acc);
    } else if (filenamePattern(name)) {
      acc.push(p);
    }
  }
  return acc;
}

// 1. npm 依赖收集
const lockFiles = findFiles(root, (name) => name === 'package-lock.json').sort();
const npmMap = new Map();

for (const lockPath of lockFiles) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const pkgs = packagesFromLock(lock);
  for (const p of pkgs) {
    const key = `${p.name}@${p.version}`;
    if (!npmMap.has(key)) {
      npmMap.set(key, {
        name: p.name,
        version: p.version,
        license: p.license || '未知',
      });
    }
  }
}

const npmPkgs = Array.from(npmMap.values()).sort((a, b) => {
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return a.version.localeCompare(b.version);
});

// 2. Python 依赖收集
const reqFiles = findFiles(root, (name) => /^requirements.*\.txt$/i.test(name)).sort();
const pythonMap = new Map();

for (const reqPath of reqFiles) {
  let parsedFromPipLicenses = false;
  try {
    const venvDir = join(dirname(reqPath), 'venv');
    const pipLicCmd = existsSync(join(venvDir, 'bin', 'pip-licenses'))
      ? `${join(venvDir, 'bin', 'pip-licenses')} --format=json`
      : 'pip-licenses --format=json';
    const jsonStr = execSync(pipLicCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = JSON.parse(jsonStr);
    for (const r of rows) {
      if (['pip-licenses', 'pip', 'setuptools', 'wheel', 'wcwidth', 'prettytable'].includes(r.Name)) continue;
      const key = `${r.Name}@${r.Version}`;
      pythonMap.set(key, {
        name: r.Name,
        version: r.Version,
        license: r.License || '未知',
      });
    }
    parsedFromPipLicenses = true;
  } catch {
    // 回退：直接文本解析 requirements.txt
  }

  if (!parsedFromPipLicenses) {
    const lines = readFileSync(reqPath, 'utf8').split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const match = line.match(/^([a-zA-Z0-9_\-.]+)(?:[=><~]=?([a-zA-Z0-9_.\-]+))?/);
      if (match) {
        const name = match[1];
        const version = match[2] || '未固定';
        const key = `${name}@${version}`;
        if (!pythonMap.has(key)) {
          pythonMap.set(key, {
            name,
            version,
            license: '未知',
          });
        }
      }
    }
  }
}

const pythonPkgs = Array.from(pythonMap.values()).sort((a, b) => {
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return a.version.localeCompare(b.version);
});

// 3. 生成 Markdown 表格
function npmLink(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
}

function pythonLink(name) {
  return `https://pypi.org/project/${encodeURIComponent(name)}/`;
}

function buildSection() {
  const lines = [
    MARKER_START,
    '## 代码依赖清单（自动生成）',
    '',
    '> 本章节由 `node scripts/generate-third-party.mjs` 从仓库内 `package-lock.json` 与 `requirements*.txt` 自动生成，请勿手动修改。',
    '',
    '### npm 依赖',
    '',
    '| 名称 | 版本 | 许可证 | 链接 |',
    '| --- | --- | --- | --- |',
  ];

  if (npmPkgs.length === 0) {
    lines.push('| 无 | - | - | - |');
  } else {
    for (const p of npmPkgs) {
      lines.push(`| ${p.name} | ${p.version} | ${p.license} | ${npmLink(p.name)} |`);
    }
  }

  lines.push('');
  lines.push('### Python 依赖');
  lines.push('');
  lines.push('| 名称 | 版本 | 许可证 | 链接 |');
  lines.push('| --- | --- | --- | --- |');

  if (pythonPkgs.length === 0) {
    lines.push('| 无 | - | - | - |');
  } else {
    for (const p of pythonPkgs) {
      lines.push(`| ${p.name} | ${p.version} | ${p.license} | ${pythonLink(p.name)} |`);
    }
  }

  lines.push(MARKER_END);
  return lines.join('\n');
}

const generatedBlock = buildSection();

// 4. 读取 docs/third-party.md 并处理
let currentDoc = existsSync(targetDocPath) ? readFileSync(targetDocPath, 'utf8') : '';

let newDoc = '';
if (currentDoc.includes(MARKER_START) && currentDoc.includes(MARKER_END)) {
  const startIndex = currentDoc.indexOf(MARKER_START);
  const endIndex = currentDoc.indexOf(MARKER_END) + MARKER_END.length;
  newDoc = currentDoc.slice(0, startIndex) + generatedBlock + currentDoc.slice(endIndex);
} else {
  // 如果没有标记，追加到末尾
  newDoc = currentDoc.trimEnd() + '\n\n' + generatedBlock + '\n';
}

if (isCheck) {
  if (currentDoc !== newDoc) {
    console.error('✗ docs/third-party.md 与当前依赖不一致！');
    console.error('请运行 `node scripts/generate-third-party.mjs` 重新生成 docs/third-party.md。');
    process.exit(1);
  } else {
    console.log('✓ docs/third-party.md 与依赖一致。');
    process.exit(0);
  }
} else {
  writeFileSync(targetDocPath, newDoc, 'utf8');
  console.log(`✓ 已成功更新 docs/third-party.md（含 ${npmPkgs.length} 个 npm 包，${pythonPkgs.length} 个 Python 包）`);
}
