import { describe, expect, it } from 'vitest';
import { MemoryInboxStore } from '../src/inbox/memory.js';
import type { InboxItem } from '../src/inbox/types.js';

const mk = (id: string, userId?: string): InboxItem => ({
  id, group: 'decision', kind: 'k', urgency: 'normal', title: 't', summary: '',
  related: { type: 'task', id: 'same' }, actions: [], status: 'open', createdAt: new Date(),
  ...(userId ? { userId } : {}),
});

describe('收件箱按账号隔离', () => {
  it('A 的条目看不到 B 和所有者的，同 related 不互相去重', async () => {
    const s = new MemoryInboxStore();
    expect((await s.insertDedup(mk('1', 'a'))).created).toBe(true);
    expect((await s.insertDedup(mk('2', 'b'))).created).toBe(true);
    expect((await s.insertDedup(mk('3'))).created).toBe(true);
    expect((await s.insertDedup(mk('4', 'a'))).created).toBe(false);
    expect((await s.list({ userId: 'a' })).map((i) => i.id)).toEqual(['1']);
    expect((await s.list({})).map((i) => i.id)).toEqual(['3']);
    expect((await s.openCounts('b')).decision).toBe(1);
    expect((await s.openCounts()).decision).toBe(1);
  });
});
