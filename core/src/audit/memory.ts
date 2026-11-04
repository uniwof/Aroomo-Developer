import { clampLimit, decodeCursor, encodeCursor, freezeEntry, InvalidCursorError, newEntryId, sanitize } from './common.js';
import type { AuditEntry, AuditInput, AuditLog, AuditPage, AuditQuery } from './types.js';

interface Row {
  seq: number;
  entry: AuditEntry;
}

/** 内存实现（测试 / 未配置数据库时）。实例被冻结，条目也被冻结，运行时无法修改。 */
export class MemoryAuditLog implements AuditLog {
  readonly #rows: Row[] = [];
  #seq = 0;
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
    Object.freeze(this);
  }

  async append(input: AuditInput): Promise<AuditEntry> {
    const clean = sanitize(input);
    this.#seq += 1;
    const entry = freezeEntry({ id: newEntryId(), ts: new Date(this.#now().getTime()), ...clean });
    this.#rows.push({ seq: this.#seq, entry });
    return entry;
  }

  async query(q: AuditQuery = {}): Promise<AuditPage> {
    const limit = clampLimit(q.limit);
    let before = Number.POSITIVE_INFINITY;
    if (q.cursor !== undefined) {
      const c = decodeCursor(q.cursor);
      if (c === null) throw new InvalidCursorError();
      before = c;
    }
    const out: Row[] = [];
    for (let i = this.#rows.length - 1; i >= 0 && out.length <= limit; i -= 1) {
      const r = this.#rows[i] as Row;
      if (r.seq >= before) continue;
      const e = r.entry;
      if (q.actor?.type && e.actor.type !== q.actor.type) continue;
      if (q.actor?.id && e.actor.id !== q.actor.id) continue;
      if (q.action && e.action !== q.action) continue;
      if (q.target?.type && e.target.type !== q.target.type) continue;
      if (q.target?.id && e.target.id !== q.target.id) continue;
      if (q.from && e.ts.getTime() < q.from.getTime()) continue;
      if (q.to && e.ts.getTime() >= q.to.getTime()) continue;
      out.push(r);
    }
    const hasMore = out.length > limit;
    const page = out.slice(0, limit);
    const last = page[page.length - 1];
    return { entries: page.map((r) => r.entry), nextCursor: hasMore && last ? encodeCursor(last.seq) : null };
  }
}
