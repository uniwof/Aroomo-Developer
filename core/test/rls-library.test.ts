/** D206 RLS：私人资源库（第 3 个模块）。 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { userScoped } from '../src/db/scope.js';
import { PgLibraryStore } from '../src/library/pg.js';
import type { LibraryItem } from '../src/library/types.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const item = (title: string, url: string | null): LibraryItem => {
  const at = new Date('2026-10-31T00:00:00Z');
  return { id: randomUUID(), kind: url ? 'link' : 'note', title, url, body: `${title} body`, tags: ['t'], source: 'manual', createdAt: at, updatedAt: at } as LibraryItem;
};

describe.each(rlsTargets)('RLS 资源库（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function seeded() {
    const db = await target.open();
    dbs.push(db);
    const store = new PgLibraryStore(db);
    const { item: secret } = await store.add('owner', item('Owner Private Note', 'https://example.com/private'));
    return { db, store, secret };
  }

  it('不设置 app.user_id 时查询为空，写入被拒', async () => {
    const { db } = await seeded();
    expect((await db.query('SELECT * FROM library_items')).rows).toEqual([]);
    await expect(
      db.query(`INSERT INTO library_items (id, user_id, kind, title, url, body, tags, source, created_at, updated_at)
                VALUES ('${randomUUID()}','owner','note','x',NULL,'','','manual',now(),now())`),
    ).rejects.toThrow(/row-level security/);
  });

  it('设为小号时看不到所有者的条目：漏写 WHERE、搜索、按 id 取、删除都无效；同一链接各存各的', async () => {
    const { db, store, secret } = await seeded();
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query('SELECT * FROM library_items')).rows).toEqual([]);
    expect((await asXiao.query<{ n: number }>('SELECT count(*)::int AS n FROM library_items')).rows[0]?.n).toBe(0);
    expect((await asXiao.query("UPDATE library_items SET title = 'hacked' RETURNING id")).rows).toEqual([]);
    expect(await store.get(XIAO, secret.id)).toBeNull();
    expect(await store.search(XIAO, ['Private'], { limit: 10 })).toEqual([]);
    expect(await store.delete(XIAO, secret.id)).toBe(false);
    // 小号存同一个链接：不会因所有者已存过而被当成「已存在」，也拿不到所有者的标题
    const r = await store.add(XIAO, item('Xiao Copy', 'https://example.com/private'));
    expect(r.existed).toBe(false);
    expect(r.item.title).toBe('Xiao Copy');
    expect((await store.list(XIAO, { limit: 10 })).map((i) => i.title)).toEqual(['Xiao Copy']);
    expect((await store.list('owner', { limit: 10 })).map((i) => i.title)).toEqual(['Owner Private Note']);
  });
});
