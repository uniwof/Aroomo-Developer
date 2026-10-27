import crypto from 'node:crypto';
import type { CreateInboxItemInput, InboxGroup, InboxItem, InboxUrgency } from './types.js';

export class InboxNotFoundError extends Error {
  constructor(message = 'Inbox item not found') {
    super(message);
    this.name = 'InboxNotFoundError';
  }
}

export class InboxConflictError extends Error {
  constructor(message = 'Inbox item action conflict or item already resolved') {
    super(message);
    this.name = 'InboxConflictError';
  }
}

export class InboxActionNotFoundError extends Error {
  constructor(message = 'Inbox action not found on item') {
    super(message);
    this.name = 'InboxActionNotFoundError';
  }
}

export interface InboxStore {
  create(input: CreateInboxItemInput): Promise<InboxItem>;
  findById(id: string): Promise<InboxItem | null>;
  list(options?: { group?: InboxGroup }): Promise<InboxItem[]>;
  getUnreadCount(): Promise<number>;
  executeAction(id: string, actionId: string): Promise<InboxItem>;
  dismiss(id: string): Promise<InboxItem>;
  batchDismiss(options?: { ids?: string[]; group?: InboxGroup }): Promise<number>;
}

const URGENCY_WEIGHT: Record<InboxUrgency, number> = {
  urgent: 0,
  normal: 1,
  low: 2,
};

export class InMemoryInboxStore implements InboxStore {
  private items = new Map<string, InboxItem>();
  private itemLocks = new Map<string, Promise<void>>();

  private async acquireLock(id: string): Promise<() => void> {
    while (this.itemLocks.has(id)) {
      await this.itemLocks.get(id);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.itemLocks.set(id, lockPromise);
    return () => {
      this.itemLocks.delete(id);
      resolveLock();
    };
  }

  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    // 检查同一 related (type + id) + kind 的 open 条目去重
    if (input.related) {
      for (const existing of this.items.values()) {
        if (
          existing.status === 'open' &&
          existing.kind === input.kind &&
          existing.related &&
          existing.related.type === input.related.type &&
          existing.related.id === input.related.id
        ) {
          return existing;
        }
      }
    }

    const item: InboxItem = {
      id: input.id ?? crypto.randomUUID(),
      group: input.group,
      kind: input.kind,
      urgency: input.urgency ?? 'normal',
      title: input.title,
      summary: input.summary,
      related: input.related,
      actions: input.actions ?? [],
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    this.items.set(item.id, item);
    return item;
  }

  async findById(id: string): Promise<InboxItem | null> {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  async list(options?: { group?: InboxGroup }): Promise<InboxItem[]> {
    let list = Array.from(this.items.values());
    if (options?.group) {
      list = list.filter((i) => i.group === options.group);
    }

    list.sort((a, b) => {
      // 1. open 在前
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (a.status !== 'open' && b.status === 'open') return 1;

      // 2. 按 urgency 排序 (urgent > normal > low)
      const uA = URGENCY_WEIGHT[a.urgency];
      const uB = URGENCY_WEIGHT[b.urgency];
      if (uA !== uB) return uA - uB;

      // 3. 按 createdAt 倒序 (最新在前)
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return list.map((i) => ({ ...i }));
  }

  async getUnreadCount(): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === 'open') count++;
    }
    return count;
  }

  async executeAction(id: string, actionId: string): Promise<InboxItem> {
    const release = await this.acquireLock(id);
    try {
      const item = this.items.get(id);
      if (!item) {
        throw new InboxNotFoundError(`Inbox item with id ${id} not found`);
      }

      if (item.status !== 'open') {
        throw new InboxConflictError(`Inbox item ${id} is already ${item.status}`);
      }

      const actionExists = item.actions.some((a) => a.id === actionId);
      if (!actionExists) {
        throw new InboxActionNotFoundError(`Action ${actionId} not found on item ${id}`);
      }

      item.status = 'done';
      item.resolvedAt = new Date().toISOString();
      item.resolvedAction = actionId;

      this.items.set(id, item);
      return { ...item };
    } finally {
      release();
    }
  }

  async dismiss(id: string): Promise<InboxItem> {
    const release = await this.acquireLock(id);
    try {
      const item = this.items.get(id);
      if (!item) {
        throw new InboxNotFoundError(`Inbox item with id ${id} not found`);
      }

      if (item.status === 'open') {
        item.status = 'dismissed';
        item.resolvedAt = new Date().toISOString();
        this.items.set(id, item);
      }

      return { ...item };
    } finally {
      release();
    }
  }

  async batchDismiss(options?: { ids?: string[]; group?: InboxGroup }): Promise<number> {
    let count = 0;
    const targetIds = options?.ids ? new Set(options.ids) : null;

    for (const item of this.items.values()) {
      if (item.status !== 'open') continue;
      if (options?.group && item.group !== options.group) continue;
      if (targetIds && !targetIds.has(item.id)) continue;

      item.status = 'dismissed';
      item.resolvedAt = new Date().toISOString();
      this.items.set(item.id, item);
      count++;
    }

    return count;
  }
}
