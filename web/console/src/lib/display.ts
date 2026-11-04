/**
 * 显示偏好（字号、主题）作用到整个控制台（#250 对标改进）。
 * - 字号（所有者 2026-11-04 23:07 + 负责人落地文档 0.3）：滑杆调的是「正文字号」，12–32px 连续可调，默认 14 = sumus 原样（prose-sm）。
 *   根字号写成百分比（正文 14 = 100%），浏览器缩放和浏览器自带字号也一起生效；全站尺寸都是 rem，跟着一起缩放。
 *   旧版存的是根字号（16 起），读的时候换算成正文字号（× 14/16）。
 * - 主题：跟随系统 / 浅色 / 深色，写成 <html class="light|dark">（index.css 已有两套变量）。
 * 偏好存在本机（和对话页同一个 key），打开任何页面时先套用一次。
 */
export type Theme = 'system' | 'light' | 'dark';

export interface DisplayPrefs {
  fontSize: number;
  theme: Theme;
}

export const PREFS_KEY = 'aroomo.chat.prefs.v1';
export const FONT_MIN = 12;
export const FONT_MAX = 32;
/** 正文字号默认 14px（= sumus） */
export const FONT_DEFAULT = 14;
/** 存的是正文字号（第 2 版）；没有这个标记的是旧版根字号 */
export const FONT_VERSION = 2;
export const clampFont = (v: number) => Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, v)) * 2) / 2;

export function readDisplayPrefs(storage: Storage | undefined = globalThis.localStorage): DisplayPrefs {
  try {
    const j = JSON.parse(storage?.getItem(PREFS_KEY) ?? '{}') as { fontSize?: unknown; theme?: unknown; fontV?: unknown };
    const raw = typeof j.fontSize === 'number' && Number.isFinite(j.fontSize) ? (j.fontV === FONT_VERSION ? j.fontSize : (j.fontSize * 14) / 16) : FONT_DEFAULT;
    const fontSize = clampFont(raw);
    const theme: Theme = j.theme === 'light' || j.theme === 'dark' ? j.theme : 'system';
    return { fontSize, theme };
  } catch {
    return { fontSize: FONT_DEFAULT, theme: 'system' };
  }
}

export function applyDisplay(p: DisplayPrefs, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  root.style.fontSize = p.fontSize === FONT_DEFAULT ? '' : `${+((p.fontSize / FONT_DEFAULT) * 100).toFixed(4)}%`;
  root.classList.remove('light', 'dark');
  if (p.theme !== 'system') root.classList.add(p.theme);
}
