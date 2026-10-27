import { redactSecrets } from './redact.js';
import type {
  AuditEntry,
  AuditLog,
  AuditLogQueryParams,
  AuditQueryResult,
  NewAuditEntry,
} from './types.js';

let counter = 0;

export class InMemoryAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];

  async append(input: NewAuditEntry): Promise<AuditEntry> {
    counter += 1;
    const now = Date.now();
    const entryId = input.id ?? `audit_${now}_${counter}_${Math.random().toString(36).substring(2, 8)}`;

    const entry: AuditEntry = {
      id: entryId,
      ts: input.ts ?? now,
      actor: {
        type: input.actor.type,
        id: redactSecrets(input.actor.id),
      },
      action: redactSecrets(input.action),
      target: {
        type: redactSecrets(input.target.type),
        id: redactSecrets(input.target.id),
      },
      result: input.result,
      ...(input.note !== undefined ? { note: redactSecrets(input.note) } : {}),
    };

    this.entries.push(entry);
    return entry;
  }

  async query(params: AuditLogQueryParams = {}): Promise<AuditQueryResult> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

    let filtered = this.entries.filter((entry) => {
      if (params.actor) {
        if (typeof params.actor === 'string') {
          if (entry.actor.id !== params.actor && entry.actor.type !== params.actor) {
            return false;
          }
        } else {
          if (params.actor.type && entry.actor.type !== params.actor.type) return false;
          if (params.actor.id && entry.actor.id !== params.actor.id) return false;
        }
      }

      if (params.action && entry.action !== params.action) {
        return false;
      }

      if (params.target) {
        if (typeof params.target === 'string') {
          if (entry.target.id !== params.target && entry.target.type !== params.target) {
            return false;
          }
        } else {
          if (params.target.type && entry.target.type !== params.target.type) return false;
          if (params.target.id && entry.target.id !== params.target.id) return false;
        }
      }

      if (params.from !== undefined && entry.ts < params.from) {
        return false;
      }

      if (params.to !== undefined && entry.ts > params.to) {
        return false;
      }

      return true;
    });

    // 默认按 ts 降序，ts 相同按 id 降序，保证游标稳定
    filtered = [...filtered].sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return b.id.localeCompare(a.id);
    });

    let startIndex = 0;
    if (params.cursor) {
      const cursorIndex = filtered.findIndex((e) => e.id === params.cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const items = filtered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + items.length < filtered.length;
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : undefined;

    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
      total: filtered.length,
    };
  }
}
