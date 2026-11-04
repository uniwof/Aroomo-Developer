/**
 * 显示偏好（字号、主题）作用到整个控制台（#250 对标改进）。
 * - 字号写到 <html> 的 font-size：对话页、抽屉里嵌的管理页、直接打开的控制台页面一起变大（都用 rem），不割裂。
 * - 主题：跟随系统 / 浅色 / 深色，写成 <html class="light|dark">（index.css 已有两套变量）。
 * 偏好存在本机（和对话页同一个 key），打开任何页面时先套用一次。
 */
export type Theme = 'system' | 'light' | 'dark';

export interface DisplayPrefs {
  fontSize: number;
  theme: Theme;
}

export const PREFS_KEY = 'aroomo.chat.prefs.v1';

export function readDisplayPrefs(storage: Storage | undefined = globalThis.localStorage): DisplayPrefs {
  try {
    const j = JSON.parse(storage?.getItem(PREFS_KEY) ?? '{}') as { fontSize?: unknown; theme?: unknown };
    const fontSize = typeof j.fontSize === 'number' && j.fontSize >= 16 && j.fontSize <= 32 ? j.fontSize : 16;
    const theme: Theme = j.theme === 'light' || j.theme === 'dark' ? j.theme : 'system';
    return { fontSize, theme };
  } catch {
    return { fontSize: 16, theme: 'system' };
  }
}

export function applyDisplay(p: DisplayPrefs, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  root.style.fontSize = p.fontSize === 16 ? '' : `${p.fontSize}px`;
  root.classList.remove('light', 'dark');
  if (p.theme !== 'system') root.classList.add(p.theme);
}
