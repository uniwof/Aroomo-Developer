/**
 * 能力清单合同类型（GET /api/capabilities，后台线提供）。
 * 后台线未就绪（404/501）时用模拟数据，页面顶部明示「示例数据」，不冒充真实数字。
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
  /** true = 模拟数据 */
  sample?: boolean;
}

export const KIND_LABEL: Record<CapabilityKind, string> = { text: '文本', image: '生图', video: '视频' };
export const ACCESS_LABEL: Record<CapabilityAccess, string> = { free: '永久免费', trial: '试用', paid: '付费' };

export function countByKind(items: CapabilityItem[]): Record<CapabilityKind, number> {
  const c: Record<CapabilityKind, number> = { text: 0, image: 0, video: 0 };
  for (const i of items) c[i.kind] += 1;
  return c;
}

/** 「文本 N · 生图 N · 视频 N」 */
export function summaryLine(items: CapabilityItem[]): string {
  const c = countByKind(items);
  return `${KIND_LABEL.text} ${c.text} · ${KIND_LABEL.image} ${c.image} · ${KIND_LABEL.video} ${c.video}`;
}

export function quotaText(q: CapabilityItem['quota']): string {
  if (!q || q.used == null || q.limit == null || q.limit <= 0) return '额度：未知';
  return `额度：已用 ${q.used} / ${q.limit} ${q.unit}`;
}

/** 种子参考 aroomo-resource-list.md（只含名称与公开额度，不含 Key） */
export const SAMPLE_ITEMS: CapabilityItem[] = [
  { id: 's-groq-120b', name: 'gpt-oss-120b', kind: 'text', provider: 'Groq', access: 'free', quota: { used: null, limit: 1000, unit: '次/天', resets: '每天' } },
  { id: 's-groq-20b', name: 'gpt-oss-20b', kind: 'text', provider: 'Groq', access: 'free', quota: { used: null, limit: 1000, unit: '次/天', resets: '每天' } },
  { id: 's-gemini-flash', name: 'gemini-2.5-flash', kind: 'text', provider: 'Google Gemini', access: 'free', quota: null },
  { id: 's-cf-ai', name: 'Workers AI 开源模型', kind: 'text', provider: 'Cloudflare', access: 'free', quota: { used: null, limit: 10000, unit: 'neurons/天', resets: '每天 00:00 UTC' } },
  { id: 's-agnes-flash', name: 'agnes-3.0-flash', kind: 'text', provider: 'Agnes AI', access: 'trial', quota: null, trialEndsAt: null },
  { id: 's-agnes-img', name: 'agnes-image-2.5', kind: 'image', provider: 'Agnes AI', access: 'trial', quota: null, trialEndsAt: null },
  { id: 's-agnes-img-flash', name: 'agnes-image-2.1-flash', kind: 'image', provider: 'Agnes AI', access: 'trial', quota: null, trialEndsAt: null },
];

/** 试用状态一句话：未填到期日 / 还剩 N 天 / 今天到期 / 已过期 N 天；非试用返回 null */
export function trialText(i: Pick<CapabilityItem, 'access' | 'trialEndsAt' | 'trialDaysLeft'>): string | null {
  if (i.access !== 'trial') return null;
  if (!i.trialEndsAt) return '到期日未填';
  const d = i.trialDaysLeft;
  if (d == null) return `试用到 ${i.trialEndsAt}`;
  if (d < 0) return `试用已过期 ${-d} 天（${i.trialEndsAt}）`;
  if (d === 0) return `试用今天到期（${i.trialEndsAt}）`;
  return `试用还剩 ${d} 天（${i.trialEndsAt}）`;
}
