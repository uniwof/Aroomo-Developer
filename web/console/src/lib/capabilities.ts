/**
 * 能力清单合同类型（GET /api/capabilities，后台线提供）。
 * 后台线未就绪（404/501）时页面显示空状态，不放示例数字（切片 15）。
 */
export type CapabilityKind = 'text' | 'image' | 'video';
/** free = 永久免费；trial = 试用（限时/一次性额度）；paid = 付费 */
export type CapabilityAccess = 'free' | 'trial' | 'paid';

export interface CapabilityItem {
  id: string;
  name: string;
  kind: CapabilityKind;
  provider: string;
  access: CapabilityAccess;
  /** 额度查不到时为 null / 缺省 → 显示「未知」 */
  quota?: { used: number | null; limit: number | null; unit: string; resets?: string } | null;
  /** 试用到期（ISO 日期）；未公布时缺省 */
  trialEndsAt?: string | null;
  /** 距到期整天数（北京时间日历日）；今天到期 = 0，已过期为负；没填到期日为 null */
  trialDaysLeft?: number | null;
}

export interface CapabilityList {
  items: CapabilityItem[];
  /** true = 接口还没上线（404/501），页面显示空状态 */
  unavailable?: boolean;
}

export const KIND_LABEL: Record<CapabilityKind, string> = { text: '聊天', image: '画图', video: '做视频' };
export const ACCESS_LABEL: Record<CapabilityAccess, string> = { free: '永久免费', trial: '试用', paid: '付费' };

export function countByKind(items: CapabilityItem[]): Record<CapabilityKind, number> {
  const c: Record<CapabilityKind, number> = { text: 0, image: 0, video: 0 };
  for (const i of items) c[i.kind] += 1;
  return c;
}

/** 「文本 N · 生图 N · 视频 N」 */
export function summaryLine(items: CapabilityItem[]): string {
  const c = countByKind(items);
  return `能${KIND_LABEL.text} ${c.text} 个 · 能${KIND_LABEL.image} ${c.image} 个 · 能${KIND_LABEL.video} ${c.video} 个`;
}

export function quotaText(q: CapabilityItem['quota']): string {
  if (!q || q.used == null || q.limit == null || q.limit <= 0) return '额度：未知';
  return `额度：已用 ${q.used} / ${q.limit} ${q.unit}`;
}

/** 试用状态一句话：未填到期日 / 还剩 N 天 / 今天到期 / 已过期 N 天；非试用返回 null */
export function trialText(i: Pick<CapabilityItem, 'access' | 'trialEndsAt' | 'trialDaysLeft'>): string | null {
  if (i.access !== 'trial') return null;
  if (!i.trialEndsAt) return '还不知道哪天到期';
  const d = i.trialDaysLeft;
  if (d == null) return `试用到 ${i.trialEndsAt}`;
  if (d < 0) return `试用已过期 ${-d} 天（${i.trialEndsAt}）`;
  if (d === 0) return `试用今天到期（${i.trialEndsAt}）`;
  return `试用还剩 ${d} 天（${i.trialEndsAt}）`;
}
