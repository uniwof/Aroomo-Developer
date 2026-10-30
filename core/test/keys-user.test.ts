import { describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../src/keys/stores.js';
import type { KeyRecord } from '../src/keys/types.js';

const rec = (id: string, userId?: string): KeyRecord => ({
  id, ...(userId ? { userId } : {}), name: id, sourceUrl: '', last4: 'abcd', model: 'openai/x', modelName: 'x',
  apiBase: null, litellmModelId: 'l' + id, status: 'active', modelsSyncedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
});

describe('Key 记录按账号隔离（越权）', () => {
  it('账号只能列出自己的 Key，所有者的不会漏给账号，反之亦然', async () => {
    const s = new MemoryKeyStore();
    await s.insert(rec('o1'));
    await s.insert(rec('a1', 'userA'));
    await s.insert(rec('b1', 'userB'));
    expect((await s.list()).map((k) => k.id)).toEqual(['o1']);
    expect((await s.list('userA')).map((k) => k.id)).toEqual(['a1']);
    expect((await s.list('userB')).map((k) => k.id)).toEqual(['b1']);
  });
});
