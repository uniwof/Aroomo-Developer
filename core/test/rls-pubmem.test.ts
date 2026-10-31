/** D206 RLS：公共记忆（第 2 个模块）。 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { userScoped } from '../src/db/scope.js';
import { PgPubMemStore } from '../src/pubmem/pg.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const at = new Date('2026-10-31T00:00:00Z');

describe.each(rlsTargets)('RLS 公共记忆（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function seeded() {
    const db = await target.open();
    dbs.push(db);
    const store = new PgPubMemStore(db);
    await store.put('owner', 'secret-topic', 'Owner Title', 'owner body v1', at);
    await store.put('owner', 'secret-topic', 'Owner Title', 'owner body v2', at); // 产生一条历史版本
    return { db, store };
  }

  it('不设置 app.user_id 时两张表查询都为空，写入被拒', async () => {
    const { db } = await seeded();
    expect((await db.query('SELECT * FROM public_memory')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM public_memory_versions')).rows).toEqual([]);
    await expect(
      db.query("INSERT INTO public_memory (user_id, topic, title, body, version, created_at, updated_at) VALUES ('owner','x','x','x',1,now(),now())"),
    ).rejects.toThrow(/row-level security/);
  });

  it('设为小号时看不到所有者的行（含历史版本），改删无效，冒充 owner 写入被拒；自己的功能可用', async () => {
    const { db, store } = await seeded();
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query('SELECT * FROM public_memory')).rows).toEqual([]);
    expect((await asXiao.query('SELECT * FROM public_memory_versions')).rows).toEqual([]);
    expect((await asXiao.query("UPDATE public_memory SET body = 'hacked' RETURNING topic")).rows).toEqual([]);
    expect((await asXiao.query('DELETE FROM public_memory_versions RETURNING topic')).rows).toEqual([]);
    await expect(
      asXiao.query("INSERT INTO public_memory_versions (user_id, topic, version, title, body, created_at) VALUES ('owner','secret-topic',99,'x','x',now())"),
    ).rejects.toThrow(/row-level security/);
    // store 层：小号的 userId 读不到、删不掉所有者的条目
    expect(await store.get(XIAO, 'secret-topic')).toBeNull();
    expect(await store.versions(XIAO, 'secret-topic')).toEqual([]);
    expect(await store.delete(XIAO, 'secret-topic')).toBe(false);
    const mine = await store.put(XIAO, 'secret-topic', 'Xiao', 'xiao body', at); // 同名话题互不影响
    expect(mine.version).toBe(1);
    expect((await store.list(XIAO)).map((e) => e.body)).toEqual(['xiao body']);
    expect((await store.get('owner', 'secret-topic'))?.body).toBe('owner body v2');
    expect((await store.versions('owner', 'secret-topic')).map((v) => v.body)).toEqual(['owner body v1']);
  });
});
