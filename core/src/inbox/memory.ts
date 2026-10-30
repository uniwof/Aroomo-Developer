import { compareInbox, INBOX_GROUPS, type InboxGroup, type InboxItem, type InboxListFilter, type InboxStatus, type InboxStore } from './types.js';

const clone = (i: InboxItem): InboxItem => structuredClone(i);

export class MemoryInboxStore implements InboxStore {
  readonly #rows = new Map<string, InboxItem>();

  async insertDedup(item: InboxItem): Promise<{ item: InboxItem; created: boolean }> {
    if (item.related) {
      for (const r of this.#rows.values()) {
        if (r.status === 'open' && r.userId === item.userId && r.kind === item.kind && r.related?.type === item.related.type && r.related.id === item.related.id) {
          return { item: clone(r), created: false };
        }
      }
    }
    this.#rows.set(item.id, clone(item));
    return { item: clone(item), created: true };
  }
  async get(id: string): Promise<InboxItem | null> {
    const r = this.#rows.get(id);
    return r ? clone(r) : null;
  }
  async list(f: InboxListFilter): Promise<InboxItem[]> {
    return [...this.#rows.values()]
      .filter((r) => (r.userId === f.userId) && (!f.group || r.group === f.group) && (!f.status || r.status === f.status))
      .sort(compareInbox)
      .map(clone);
  }
  async openCounts(userId?: string): Promise<Record<InboxGroup, number>> {
    const out = Object.fromEntries(INBOX_GROUPS.map((g) => [g, 0])) as Record<InboxGroup, number>;
    for (const r of this.#rows.values()) if (r.status === 'open' && r.userId === userId) out[r.group] += 1;
    return out;
  }
  async resolveIfOpen(
    id: string,
    next: { status: Exclude<InboxStatus, 'open'>; resolvedAt: Date; resolvedAction?: string },
  ): Promise<InboxItem | null> {
    // 同步完成「检查 + 修改」，中间没有 await，单线程下天然原子
    const r = this.#rows.get(id);
    if (!r || r.status !== 'open') return null;
    r.status = next.status;
    r.resolvedAt = new Date(next.resolvedAt);
    if (next.resolvedAction !== undefined) r.resolvedAction = next.resolvedAction;
    return clone(r);
  }
}
