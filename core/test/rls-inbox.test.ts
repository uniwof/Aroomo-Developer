/** D206 RLS：收件箱表（A+）。 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { userScoped } from '../src/db/scope.js';
import { PgInboxStore } from '../src/inbox/pg.js';
import type { InboxItem } from '../src/inbox/types.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const OWN = '00000000-0000-4000-8000-0000000000a1';
const XIT = '00000000-0000-4000-8000-0000000000b2';
const at = new Date('2026-10-31T01:30:00Z');
const item = (id: string, userId?: string): InboxItem => ({
  id, group: 'decision', kind: 'k', urgency: 'normal', title: id, summary: 's',
  related: { type: 't', id }, actions: [{ id: 'ok', label: '好' }], status: 'open', createdAt: at,
  ...(userId ? { userId } : {}),
});

describe.each(rlsTargets)('RLS 收件箱（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function seeded() {
    const db = await target.open();
    dbs.push(db);
    const store = new PgInboxStore(db);
    await store.insertDedup(item(OWN));
    return { db, store };
  }

  it('不设置 app.user_id 时查询为空、写入被拒', async () => {
    const { db } = await seeded();
    expect((await db.query('SELECT * FROM inbox_items')).rows).toEqual([]);
    await expect(
      db.query(`INSERT INTO inbox_items (id,grp,kind,urgency,title,summary,actions,status,created_at,user_id) VALUES ('00000000-0000-4000-8000-0000000000c3','decision','k','normal','t','s','[]','open',now(),'owner')`),
    ).rejects.toThrow(/row-level security/);
  });

  it('设为小号时看不到、改不了、删不了所有者的条目，也看不出存在', async () => {
    const { db, store } = await seeded();
    await store.insertDedup(item(XIT, XIAO));
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query<{ id: string }>('SELECT id FROM inbox_items')).rows.map((r) => r.id)).toEqual([XIT]);
    expect((await asXiao.query(`UPDATE inbox_items SET status='done' WHERE id='${OWN}' RETURNING id`)).rows).toEqual([]);
    expect((await asXiao.query(`DELETE FROM inbox_items WHERE id='${OWN}' RETURNING id`)).rows).toEqual([]);
    await expect(asXiao.query(`UPDATE inbox_items SET user_id='owner' WHERE id='${XIT}'`)).rejects.toThrow(/row-level security/);
    expect((await store.list({ userId: XIAO })).map((i) => i.id)).toEqual([XIT]);
    expect((await store.openCounts(XIAO)).decision).toBe(1);
    expect((await store.list({})).map((i) => i.id)).toEqual([OWN]);
    expect((await store.get(OWN))?.userId).toBeUndefined();
  });
});
