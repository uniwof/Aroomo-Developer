/**
 * 显示偏好（字号、主题）作用到整个控制台（#250 对标改进）。
 * - 字号写到 <html> 的 font-size（所有者 2026-11-04 23:07：可任意调整，不设 16px 下限）：12–32 连续可调，默认 16 = sumus 原尺寸。
 *   写成百分比（16 = 100%），所以浏览器自己的默认字号和缩放也一起生效；全站尺寸都是 rem，跟着一起缩放。
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
export const FONT_DEFAULT = 16;
export const clampFont = (v: number) => Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, v)) * 2) / 2;

export function readDisplayPrefs(storage: Storage | undefined = globalThis.localStorage): DisplayPrefs {
  try {
    const j = JSON.parse(storage?.getItem(PREFS_KEY) ?? '{}') as { fontSize?: unknown; theme?: unknown };
    const fontSize = typeof j.fontSize === 'number' && Number.isFinite(j.fontSize) ? clampFont(j.fontSize) : FONT_DEFAULT;
    const theme: Theme = j.theme === 'light' || j.theme === 'dark' ? j.theme : 'system';
    return { fontSize, theme };
  } catch {
    return { fontSize: FONT_DEFAULT, theme: 'system' };
  }
}

export function applyDisplay(p: DisplayPrefs, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  root.style.fontSize = p.fontSize === FONT_DEFAULT ? '' : `${+((p.fontSize / 16) * 100).toFixed(4)}%`;
  root.classList.remove('light', 'dark');
  if (p.theme !== 'system') root.classList.add(p.theme);
}
