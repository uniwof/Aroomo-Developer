// 关着的功能不进对话页包（#323 负责人第二轮的发现）。构建器只内联顶层常量、不内联对象属性，
// 所以开关必须是 src/lib/flags.ts、work-flag.ts 里一个个的 `export const X = true|false;`。
// 这里读开关的值，开关关着时它的标志文字不能出现在 dist/assets/ChatPage-*.js 里。check-chat-size.mjs 构建后会调用它。
// 单独用：npm run build && node scripts/check-flags-shaken.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..') + '/';
// 开关 → 只在它打开时才该出现在对话页包里的文字（界面上的字或接口地址）。新加开关、新功能时补一行。
const MARKERS = {
  CONV_FILTER: ['筛选对话'],
  SCHEDULE_PAGE: ['看全部计划'],
  WORK: ['/work'],
};

export function readFlags() {
  const flags = {};
  for (const f of ['src/lib/flags.ts', 'src/lib/work-flag.ts']) {
    const src = readFileSync(root + f, 'utf8');
    if (/export\s+const\s+\w+\s*=\s*\{/.test(src)) throw new Error(`${f}：开关不能写成对象（构建器不内联对象属性，关着的代码会进包）`);
    for (const [, k, v] of src.matchAll(/^export const (\w+) = (true|false);$/gm)) flags[k] = v === 'true';
  }
  return flags;
}

export function checkFlagsShaken() {
  const flags = readFlags();
  const dir = root + 'dist/assets/';
  const chunk = readdirSync(dir).find((f) => /^ChatPage-[\w-]+\.js$/.test(f));
  if (!chunk) throw new Error('dist/assets 里没有 ChatPage-*.js，先 npm run build');
  const js = readFileSync(dir + chunk, 'utf8');
  const leaked = [];
  for (const [flag, words] of Object.entries(MARKERS)) {
    if (!(flag in flags)) throw new Error(`MARKERS 里的 ${flag} 不在 flags.ts / work-flag.ts`);
    if (flags[flag]) continue;
    for (const w of words) if (js.includes(w)) leaked.push(`${flag}（关）：对话页包里有「${w}」`);
  }
  return leaked;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const leaked = checkFlagsShaken();
  if (leaked.length) {
    console.error('关着的功能进了对话页包（开关要写成顶层常量、直接 import）：\n' + leaked.join('\n'));
    process.exit(1);
  }
  console.log('关着的开关都没进对话页包');
}
