/**
 * 阶段 2 预审（Gemini）会话部分：导入时消息多行一次插（不再一条一条 await），一大批也只用几次往返；顺序和内容不变。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgConversationStore } from '../src/conversations/pg.js';
import type { ChatMessage } from '../src/conversations/types.js';
import type { Db, Queryable } from '../src/db/db.js';
import { dbTargets } from './helpers/db.js';

/** 数一数发到库里的语句（含事务里的） */
function counting(db: Db): { db: Db; count: () => number } {
  let n = 0;
  const wrap = (q: Queryable): Queryable => ({
    query: ((sql: string, params?: unknown[]) => {
      n++;
      return q.query(sql, params);
    }) as Queryable['query'],
    exec: (sql: string) => {
      n++;
      return q.exec(sql);
    },
  });
  return { db: { ...wrap(db), tx: (fn) => db.tx((q) => fn(wrap(q))), close: () => db.close() }, count: () => n };
}

describe.each(dbTargets)('会话导入多行插入（$name）', (target) => {
  it('一个会话 1200 条消息：语句数和条数无关（≤ 8 次），顺序与内容不变', async () => {
    const raw = await target.open();
    const { db, count } = counting(raw);
    try {
      const store = new PgConversationStore(db);
      const T0 = new Date('2026-11-05T11:00:00Z');
      const id = randomUUID();
      const msgs: ChatMessage[] = Array.from({ length: 1200 }, (_, i) => ({
        id: randomUUID(), conversationId: id, userId: 'owner', role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句`, meta: i % 2 ? { imported: true } : null, createdAt: new Date(T0.getTime() + i),
      }));
      const before = count();
      expect(await store.create('owner', { id, userId: 'owner', title: '导入', model: 'aroomo', groupNames: [], readAt: T0, archivedAt: null, createdAt: T0, updatedAt: T0 }, msgs)).toBe('ok');
      expect(count() - before).toBeLessThanOrEqual(8);
      const got = await store.messages('owner', id, { limit: 200, afterSeq: 0 });
      expect(got.map((m) => m.content).slice(0, 3)).toEqual(['第 0 句', '第 1 句', '第 2 句']);
      expect(got[1]!.meta).toEqual({ imported: true });
      const tail = await store.messages('owner', id, { limit: 200, beforeSeq: 2_000_000_000 });
      expect(tail.at(-1)!.content).toBe('第 1199 句');
    } finally {
      await raw.close();
    }
  });
});
