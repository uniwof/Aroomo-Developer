/**
 * Skin/Bones 右侧抽屉 ↔ 地址查询参数（Poke #250 补充规范 Bones 第 2 条，切片 2）。契约：
 *   ?drawer=<id>          打开 id 这个抽屉，常规宽 480（Standard）
 *   ?drawer=<id>&w=640    同一个抽屉，宽档 640（Wide：长文、详细审计、复杂策略）
 *   没有 drawer           关着（默认）
 * 只认这两个键，地址里别的参数（/team?member=… 这类）原样保留。id 只收小写字母、数字、连字符，最长 40 位；
 * 坏 id、w 不是 640 都按「关着 / 常规宽」处理，不报错。
 * 开关 SKIN_BONES 关着时没有人 import 这个文件（ChatPage 里的引用都在开关常量后面），代码不进对话页包。
 */
export type DrawerState = { id: string; wide: boolean };

const ID = /^[a-z0-9-]{1,40}$/;

/** 地址的 search（带不带 ? 都行）→ 抽屉状态；没开返回 null */
export function drawerOf(search: string): DrawerState | null {
  const q = new URLSearchParams(search);
  const id = q.get('drawer');
  if (!id || !ID.test(id)) return null;
  return { id, wide: q.get('w') === '640' };
}

/** 在现有 search 上写入抽屉状态（null = 关）；返回 '' 或 '?…' */
export function withDrawer(search: string, d: DrawerState | null): string {
  const q = new URLSearchParams(search);
  q.delete('drawer');
  q.delete('w');
  if (d) {
    q.set('drawer', d.id);
    if (d.wide) q.set('w', '640');
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** 去掉抽屉参数后的 search：面板的 ErrorBoundary 用它当 key，开关抽屉不重挂面板（不然打开抽屉的按钮被换掉，关上后焦点回不去） */
export const withoutDrawer = (search: string) => withDrawer(search, null);
