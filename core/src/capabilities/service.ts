import { CAPABILITY_SEED } from './seed.js';
import type { CapabilityAccess, CapabilityItem, CapabilityKind, CapabilitySeed } from './types.js';

const KIND_LABEL: Record<CapabilityKind, string> = { text: '文本', image: '生图', video: '视频' };

export function countByKind(items: CapabilityItem[]): Record<CapabilityKind, number> {
  const c: Record<CapabilityKind, number> = { text: 0, image: 0, video: 0 };
  for (const i of items) c[i.kind] += 1;
  return c;
}

export function countByAccess(items: { access: CapabilityAccess }[]): Record<CapabilityAccess, number> {
  const c: Record<CapabilityAccess, number> = { free: 0, trial: 0, paid: 0 };
  for (const i of items) c[i.access] += 1;
  return c;
}

/** 「文本 N · 生图 N · 视频 N」 */
export function summaryLine(items: CapabilityItem[]): string {
  const c = countByKind(items);
  return `${KIND_LABEL.text} ${c.text} · ${KIND_LABEL.image} ${c.image} · ${KIND_LABEL.video} ${c.video}`;
}

export class CapabilityService {
  constructor(private readonly seed: CapabilitySeed = CAPABILITY_SEED) {}

  /** 额度查不到（used 或 limit 为 null）统一为「未知」：quotaKnown=false */
  list(filter: { kind?: CapabilityKind; access?: CapabilityAccess } = {}) {
    const items = this.seed.items.filter((i) => (!filter.kind || i.kind === filter.kind) && (!filter.access || i.access === filter.access));
    const withKnown = <T extends { quota: CapabilityItem['quota'] }>(x: T) => ({
      ...x,
      quotaKnown: !!x.quota && x.quota.used != null && x.quota.limit != null,
    });
    return {
      items: items.map(withKnown),
      tools: this.seed.tools.filter((t) => !filter.access || t.access === filter.access).map(withKnown),
      counts: countByKind(items),
      access: countByAccess(items),
      summary: summaryLine(items),
      library: this.seed.library,
      // 种子数据（非实时查询）：控制台可据此标注
      sample: false,
      source: this.seed.source,
    };
  }
}
