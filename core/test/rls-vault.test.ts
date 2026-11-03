/** D206 RLS：保险箱表（A+）。 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { PgVaultStore } from '../src/vault/pg.js';
import type { SecretRecord } from '../src/vault/types.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const at = new Date('2026-10-31T09:30:00+08:00');
const rec = (userId: string, id: string, name: string): SecretRecord => ({
  id, userId, name, kind: 'api_key', last4: 'abcd', ciphertext: 'ct', dekWrapped: 'dk', nonce: 'nn',
  createdAt: at, updatedAt: at, rotatedAt: null, deletedAt: null,
});

describe.each(rlsTargets)('RLS 保险箱（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function seeded() {
    const db = await target.open();
    dbs.push(db);
    const store = new PgVaultStore(db);
    await store.insert(rec('owner', 'owner-secret', 'OwnerKey'));
    return { db, store };
  }

  it('不设置 app.user_id 时查询为空、计数 0、写入被拒', async () => {
    const { db } = await seeded();
    expect((await db.query('SELECT * FROM vault_secrets')).rows).toEqual([]);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM vault_secrets')).rows[0]?.n).toBe(0);
    await expect(
      db.query(`INSERT INTO vault_secrets (id,user_id,name,kind,last4,ciphertext,dek_wrapped,nonce,created_at,updated_at) VALUES ('s','owner','n','api_key','1','c','d','n',now(),now())`),
    ).rejects.toThrow(/row-level security/);
  });

  it('设为小号时看不到、改不了、删不了所有者的密文，也伪造不了 user_id', async () => {
    const { db, store } = await seeded();
    await store.insert(rec(XIAO, 'xiao-secret', 'XiaoKey'));
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query<{ id: string }>('SELECT id FROM vault_secrets')).rows.map((r) => r.id)).toEqual(['xiao-secret']);
    expect((await asXiao.query("UPDATE vault_secrets SET ciphertext='x' WHERE id='owner-secret' RETURNING id")).rows).toEqual([]);
    expect((await asXiao.query("DELETE FROM vault_secrets WHERE id='owner-secret' RETURNING id")).rows).toEqual([]);
    await expect(asXiao.query("UPDATE vault_secrets SET user_id='owner' WHERE id='xiao-secret'")).rejects.toThrow(/row-level security/);
    expect(await store.get(XIAO, 'owner-secret')).toBeNull();
    expect(await store.replace(XIAO, 'owner-secret', { ciphertext: 'z', dekWrapped: 'z', nonce: 'z' }, 'zzzz', at)).toBe(false);
    expect(await store.erase(XIAO, 'owner-secret', at)).toBe(false);
    expect((await store.get('owner', 'owner-secret'))?.ciphertext).toBe('ct');
    expect((await store.list(XIAO)).map((s) => s.name)).toEqual(['XiaoKey']);
    expect(await store.countAll()).toBe(2);
  });

  it('小号可以新建和所有者同名的密钥（名称唯一约束含 user_id），各自只看到自己的', async () => {
    const { store } = await seeded();
    await store.insert(rec(XIAO, 'xiao-same-name', 'OwnerKey'));
    expect((await store.list(XIAO)).map((s) => s.id)).toEqual(['xiao-same-name']);
    expect((await store.list('owner')).map((s) => s.id)).toEqual(['owner-secret']);
    await expect(store.insert(rec(XIAO, 'xiao-dup', 'ownerkey'))).rejects.toThrow();
  });

  it('系统范围只读：UPDATE / DELETE / INSERT 都被拒，所有者的数据不变', async () => {
    const { db, store } = await seeded();
    const sys = systemScoped(db);
    expect((await sys.query('SELECT id FROM vault_secrets')).rows).toHaveLength(1);
    expect((await sys.query("UPDATE vault_secrets SET ciphertext='x' WHERE id='owner-secret' RETURNING id")).rows).toEqual([]);
    expect((await sys.query("DELETE FROM vault_secrets WHERE id='owner-secret' RETURNING id")).rows).toEqual([]);
    await expect(
      sys.query(`INSERT INTO vault_secrets (id,user_id,name,kind,last4,ciphertext,dek_wrapped,nonce,created_at,updated_at) VALUES ('s2','owner','n2','api_key','1','c','d','n',now(),now())`),
    ).rejects.toThrow(/row-level security/);
    expect((await store.get('owner', 'owner-secret'))?.ciphertext).toBe('ct');
  });
});
