// 关着的功能不进对话页包（#323 负责人第二轮的发现）。构建器只内联顶层常量、不内联对象属性，
// 所以开关必须是 src/lib/flags.ts、work-flag.ts 里一个个的 `export const X = true|false;`。
// 这里读开关的值，开关关着时它的标志文字不能出现在 dist/assets/ChatPage-*.js 里。check-chat-size.mjs 构建后会调用它。
// 单独用：npm run build && node scripts/check-flags-shaken.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..') + '/';
// 开关 → 只在它打开时才该出现在对话页包里的文字（界面上的字或接口地址；字符串按子串查，正则按正则查）。
// 每个开关必须在 MARKERS 或 NO_MARKER 里（#327）：新加开关两边都没写，构建核对和单测都会失败。
export const MARKERS = {
  CONV_FILTER: ['筛选对话'],
  SCHEDULE_PAGE: ['看全部计划'],
  // /work 后面不能紧跟字母、数字、_ 或 -，免得 /workspace、/workflow 误判（负责人 #326 建议 2）。
  // 没用 /api/work/：那些请求都在 WorkPage 懒加载包里，WORK 打开时对话页包里也没有，查了等于没查（实测 2026-11-07）。
  WORK: [/\/work(?![\w-])/],
  ASSISTANTS: ['助手列表没加载出来'],
  // #329（负责人 #328 建议）：现在不在对话页包里（出现 0 次照样绿），以后谁把它们直接 import 进对话页又没加开关，当场抓到。
  // 标志文字是组件独有的界面字：TaskCard 的确认块「花多少：」、反问块输入框「写你的回答」；QuickReplies 的「我自己写…」
  TASK_CARDS: ['花多少：', '写你的回答'],
  QUICK_REPLIES: ['我自己写…'],
};
// 不查的开关和原因（核对时间 2026-11-07，#327）。代码挪进对话页包了就改成 MARKERS。
export const NO_MARKER = {
  ASSISTANT_DRAFT: '对话页包里只有 ChatPage 一个三元式（受 ASSISTANTS 一起管）；草稿卡在 AssistantPages / ChatDraftCard 懒加载包',
  SAVED_CHATS: '只决定走 Core 还是本机：saved.ts 被 Sidebar 搜索直接 import，/api/conversations 关着也在包里，没有只属于它的文字',
  SKELETON_SHIMMER: '只换一个 class 名（sk--shimmer），AppSkeleton 在入口包（App.tsx），不在对话页包',
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

/** 两份名单都没写的开关 */
export function uncovered(flags) {
  return Object.keys(flags).filter((k) => !(k in MARKERS) && !(k in NO_MARKER));
}

/** 关着的开关的标志文字出现在 js 里的，一条一句 */
export function findLeaks(js, flags) {
  const leaked = [];
  for (const [flag, words] of Object.entries(MARKERS)) {
    if (!(flag in flags)) throw new Error(`MARKERS 里的 ${flag} 不在 flags.ts / work-flag.ts`);
    if (flags[flag]) continue;
    for (const w of words) if (typeof w === 'string' ? js.includes(w) : w.test(js)) leaked.push(`${flag}（关）：对话页包里有「${w}」`);
  }
  return leaked;
}

export function checkFlagsShaken() {
  const flags = readFlags();
  const missing = uncovered(flags);
  if (missing.length) throw new Error(`这些开关不在 MARKERS 也不在 NO_MARKER（scripts/check-flags-shaken.mjs）：${missing.join('、')}。写上标志文字，或写一句为什么不查`);
  for (const k of Object.keys(NO_MARKER)) if (!(k in flags)) throw new Error(`NO_MARKER 里的 ${k} 不在 flags.ts / work-flag.ts，删掉这一条`);
  const dir = root + 'dist/assets/';
  const chunk = readdirSync(dir).find((f) => /^ChatPage-[\w-]+\.js$/.test(f));
  if (!chunk) throw new Error('dist/assets 里没有 ChatPage-*.js，先 npm run build');
  return findLeaks(readFileSync(dir + chunk, 'utf8'), flags);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const leaked = checkFlagsShaken();
  if (leaked.length) {
    console.error('关着的功能进了对话页包（开关要写成顶层常量、直接 import）：\n' + leaked.join('\n'));
    process.exit(1);
  }
  console.log('关着的开关都没进对话页包');
}
