/** D206 RLS：provider_keys 表（A+）。 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { userScoped } from '../src/db/scope.js';
import { PgKeyStore } from '../src/keys/stores.js';
import type { KeyRecord } from '../src/keys/types.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const OWN = '00000000-0000-4000-8000-0000000000a1';
const XIT = '00000000-0000-4000-8000-0000000000b2';
const at = new Date('2026-10-31T09:30:00+08:00');
const key = (id: string, userId?: string): KeyRecord => ({
  id, name: id.slice(-4), sourceUrl: 'https://example.com', last4: '1234', model: 'openai/x', modelName: 'x',
  apiBase: null, litellmModelId: `lm-${id}`, status: 'active', modelsSyncedAt: null, createdAt: at, updatedAt: at,
  ...(userId ? { userId } : {}),
});

describe.each(rlsTargets)('RLS Key 元数据（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function seeded() {
    const db = await target.open();
    dbs.push(db);
    const store = new PgKeyStore(db);
    await store.insert(key(OWN));
    return { db, store };
  }

  it('不设置 app.user_id 时查询为空、写入被拒', async () => {
    const { db } = await seeded();
    expect((await db.query('SELECT * FROM provider_keys')).rows).toEqual([]);
    await expect(
      db.query(`INSERT INTO provider_keys (id,name,source_url,last4,model,model_name,litellm_model_id,status,created_at,updated_at,user_id) VALUES ('00000000-0000-4000-8000-0000000000c3','nm','u','1234','m','m','lm-c3','active',now(),now(),'owner')`),
    ).rejects.toThrow(/row-level security/);
  });

  it('设为小号时看不到、改不了、删不了所有者的 Key，也看不出存在', async () => {
    const { db, store } = await seeded();
    await store.insert(key(XIT, XIAO));
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query<{ id: string }>('SELECT id FROM provider_keys')).rows.map((r) => r.id)).toEqual([XIT]);
    expect((await asXiao.query(`UPDATE provider_keys SET name='hacked' WHERE id='${OWN}' RETURNING id`)).rows).toEqual([]);
    expect((await asXiao.query(`DELETE FROM provider_keys WHERE id='${OWN}' RETURNING id`)).rows).toEqual([]);
    await expect(asXiao.query(`UPDATE provider_keys SET user_id='owner' WHERE id='${XIT}'`)).rejects.toThrow(/row-level security/);
    expect((await store.list(XIAO)).map((k) => k.id)).toEqual([XIT]);
    expect((await store.list()).map((k) => k.id)).toEqual([OWN]);
    expect((await store.get(OWN))?.userId).toBeUndefined();
  });
});
