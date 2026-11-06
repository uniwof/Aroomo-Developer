// #281：对话页包（ChatPage 入口 chunk）gzip 后不能超过 150 KB（#250 目标）。
// 读 `vite build` 的输出（就是大家在构建日志里看到的那个 gzip 数），超了就失败，免得再悄悄涨回去。
// 用法：npm run build 2>&1 | tee build.log && node scripts/check-chat-size.mjs build.log
import { readFileSync } from 'node:fs';

const LIMIT_KB = 150;
const log = readFileSync(process.argv[2] ?? 'build.log', 'utf8').replace(/\u001b\[[0-9;]*m/g, '');
const m = log.match(/assets\/ChatPage-[\w-]+\.js\s+[\d.]+ kB\s*│\s*gzip:\s*([\d.]+) kB/);
if (!m) {
  console.error('没在构建输出里找到对话页包（assets/ChatPage-*.js）的 gzip 大小');
  process.exit(1);
}
const kb = Number(m[1]);
if (kb > LIMIT_KB) {
  console.error(`对话页包 gzip ${kb} kB，超过 ${LIMIT_KB} kB（#250）。不常开的面板改成点开才下载（参照 ChatPage.tsx 的 lazy 和 ClientTokensLazy）。`);
  process.exit(1);
}
console.log(`对话页包 gzip ${kb} kB ≤ ${LIMIT_KB} kB（余量 ${(LIMIT_KB - kb).toFixed(2)} kB）`);
