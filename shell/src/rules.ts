/**
 * 界面层的规则表（PRODUCT §8；D68 隐藏不删除；DECISIONS 提议 H1）。
 * 浏览器端 shell.js 有一份同样的列表（从 /aroomo/static/rules.json 读取，同一个来源）。
 */

/** 品牌：页面里出现的上游产品名替换成 Aroomo（区分大小写，不改网址里的小写 lobehub） */
export const BRAND_FROM = /LobeHub|LobeChat|Lobe Chat/g;
export const BRAND_TO = 'Aroomo';

/**
 * §8 没有列出的 LobeHub 顶级页面：整页打开时 302 到首页（D68 隐藏，不删除；上游代码与数据不动）。
 * 设置 / 我的 → Aroomo 设置（§8.3：左侧 Tab 通用、负责人、账号、通知、安全、高级）。
 */
export const HIDDEN_PREFIXES = [
  'community',
  'discover',
  'image',
  'video',
  'page',
  'resource',
  'memory',
  'tasks',
  'task',
  'eval',
  'goal',
  'goals',
  'dashboard',
  'labs',
  'devices',
  'channel',
  'connector',
  'skill',
  'mcp',
  'changelog',
] as const;

export const REDIRECTS: Record<string, string> = {
  settings: '/aroomo/settings',
  me: '/aroomo/settings',
  profile: '/aroomo/settings/account',
};

/** D68：朗读（TTS）既隐藏又禁用——服务端直接拒绝这些接口 */
export const BLOCKED_API_PREFIXES = ['/webapi/tts/'];

export type NavDecision = { kind: 'pass' } | { kind: 'redirect'; location: string };

/** 只对整页导航（浏览器地址栏 / 刷新）生效；SPA 内跳转由 shell.js 处理。 */
export function decideNavigation(pathname: string): NavDecision {
  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  // 带语言 / 设备变体前缀的路径（例如 /zh-CN__0__light/...）不在这里判断
  if (first in REDIRECTS) return { kind: 'redirect', location: REDIRECTS[first]! };
  if ((HIDDEN_PREFIXES as readonly string[]).includes(first)) return { kind: 'redirect', location: '/' };
  return { kind: 'pass' };
}

export function isBlockedApi(pathname: string): boolean {
  return BLOCKED_API_PREFIXES.some((p) => pathname.startsWith(p));
}
