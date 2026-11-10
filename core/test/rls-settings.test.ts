/** D206 RLS：#345 P1 core_settings（迁移 0037，A+）：加 user_id 列，键名前缀 u<hex>. 换算成账号 id。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { PgSettingsStore, scopedSettings, settingsOwnerOf } from '../src/settings/store.js';
import { openPglite } from './helpers/db.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const OTHER = '00000000-0000-4000-8000-00000000b22d';
const T0 = new Date('2026-11-10T00:00:00Z');
const RLS = /row-level security/;
const xiaoKey = (k: string) => `u${XIAO.replaceAll('-', '')}.${k}`;

describe('settingsOwnerOf', () => {
  it('带 u<32 位十六进制>. 前缀 → 标准 UUID；其余 → owner', () => {
    expect(settingsOwnerOf(xiaoKey('lead'))).toBe(XIAO);
    expect(settingsOwnerOf('lead')).toBe('owner');
    expect(settingsOwnerOf('usage.limits')).toBe('owner');
    expect(settingsOwnerOf(`u${'A'.repeat(32)}.x`)).toBe('owner'); // 大写不算前缀
    expect(settingsOwnerOf(`u${'a'.repeat(31)}.x`)).toBe('owner');
  });
});

describe.each(rlsTargets)('RLS P1 core_settings（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function open() {
    const db = await target.open();
    dbs.push(db);
    return db;
  }
  const raw = (db: Db, key: string, uid: string) =>
    db.query(`INSERT INTO core_settings (user_id, key, value, updated_at) VALUES ($1, $2, '1'::jsonb, now())`, [uid, key]);

  it('ENABLE + FORCE，且只有 core_settings_user 和 core_settings_system_read 两条策略', async () => {
    const db = await open();
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'core_settings' AND relnamespace = current_schema()::regnamespace`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = (await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'core_settings' AND schemaname = current_schema() ORDER BY policyname`)).rows;
    expect(pol.map((p) => [p.policyname, p.cmd])).toEqual([['core_settings_system_read', 'SELECT'], ['core_settings_user', 'ALL']]);
  });

  it('不设 app.user_id：查询为空、写入被拒', async () => {
    const db = await open();
    await new PgSettingsStore(db).set('lead', { memberId: 'm' }, T0);
    expect((await db.query('SELECT * FROM core_settings')).rows).toEqual([]);
    await expect(raw(db, 'k', 'owner')).rejects.toThrow(RLS);
  });

  it('小号看不到、改不了、删不了所有者的设置；冒充 owner 写入被拒', async () => {
    const db = await open();
    const s = new PgSettingsStore(db);
    await s.set('lead', { memberId: 'owner-m' }, T0);
    await s.set(xiaoKey('lead'), { memberId: 'xiao-m' }, T0);
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query<{ key: string }>('SELECT key FROM core_settings')).rows.map((r) => r.key)).toEqual([xiaoKey('lead')]);
    expect((await asXiao.query(`UPDATE core_settings SET value='{"hacked":true}' WHERE key='lead' RETURNING key`)).rows).toEqual([]);
    expect((await asXiao.query(`DELETE FROM core_settings WHERE key='lead' RETURNING key`)).rows).toEqual([]);
    await expect(raw(asXiao, 'other', 'owner')).rejects.toThrow(RLS);
    await expect(raw(asXiao, xiaoKey('x'), OTHER)).rejects.toThrow(RLS);
    await expect(asXiao.query(`UPDATE core_settings SET user_id='owner' WHERE key='${xiaoKey('lead')}'`)).rejects.toThrow(RLS);
    // 所有者的行原样
    expect(await s.get('lead')).toEqual({ memberId: 'owner-m' });
    expect(await s.get(xiaoKey('lead'))).toEqual({ memberId: 'xiao-m' });
  });

  it('user_id 必须和键名前缀一致（CHECK）：所有者角色也不能把小号的键写到别的账号名下', async () => {
    const db = await open();
    const asXiao = userScoped(db, XIAO);
    await expect(raw(asXiao, 'plain', XIAO)).rejects.toThrow(/core_settings_user_id_matches_key/); // 无前缀的键只能归 owner
    const asOwner = userScoped(db, 'owner');
    await expect(raw(asOwner, xiaoKey('k'), 'owner')).rejects.toThrow(/core_settings_user_id_matches_key/); // 带前缀的键不能记在 owner 名下
  });

  it('PgSettingsStore：scopedSettings 的两个账号互相读不到；同名键各存各的', async () => {
    const db = await open();
    const s = new PgSettingsStore(db);
    const owner = scopedSettings(s, 'owner');
    const xiao = scopedSettings(s, XIAO);
    const other = scopedSettings(s, OTHER);
    await owner.set('usage.limits', { n: 1 }, T0);
    await xiao.set('usage.limits', { n: 2 }, T0);
    await xiao.set('usage.limits', { n: 3 }, T0); // 覆盖
    expect(await owner.get('usage.limits')).toEqual({ n: 1 });
    expect(await xiao.get('usage.limits')).toEqual({ n: 3 });
    expect(await other.get('usage.limits')).toBeNull();
    const rows = (await systemScoped(db).query<{ user_id: string; key: string }>('SELECT user_id, key FROM core_settings ORDER BY key')).rows;
    expect(rows).toEqual([{ user_id: XIAO, key: xiaoKey('usage.limits') }, { user_id: 'owner', key: 'usage.limits' }].sort((a, b) => (a.key < b.key ? -1 : 1)));
  });

  it('漏写 WHERE 也只看到自己的行；系统范围只读、写不了', async () => {
    const db = await open();
    const s = new PgSettingsStore(db);
    await s.set('a', 1, T0);
    await s.set(xiaoKey('a'), 2, T0);
    expect((await userScoped(db, XIAO).query('SELECT * FROM core_settings')).rows).toHaveLength(1);
    expect((await userScoped(db, 'owner').query('SELECT * FROM core_settings')).rows).toHaveLength(1);
    const sys = systemScoped(db);
    expect((await sys.query('SELECT * FROM core_settings')).rows).toHaveLength(2);
    expect((await sys.query(`UPDATE core_settings SET value='0'::jsonb RETURNING key`)).rows).toEqual([]);
    expect((await sys.query(`DELETE FROM core_settings RETURNING key`)).rows).toEqual([]);
    await expect(raw(sys, 'zz', 'owner')).rejects.toThrow(RLS);
  });
});

describe('迁移 0037 回退与回填', () => {
  it('up → down → up：down 关 RLS 并删 user_id 列、清迁移记录；旧数据按键名前缀回填', async () => {
    const db = await openPglite();
    try {
      const DOWN = readFileSync(fileURLToPath(new URL('../migrations/down/0037_rls_p1_settings.down.sql', import.meta.url)), 'utf8');
      const forced = async () => (await db.query<{ f: boolean }>(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'core_settings' AND relnamespace = current_schema()::regnamespace`)).rows[0]!.f;
      const cols = async () => (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'core_settings' AND table_schema = current_schema()`)).rows.map((r) => r.column_name);
      expect(await forced()).toBe(true);
      await db.exec(DOWN);
      expect(await forced()).toBe(false);
      expect(await cols()).not.toContain('user_id');
      expect((await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0037_rls_p1_settings.sql'`)).rows).toEqual([]);
      // 回退状态下按旧版写法写三个键（所有者、小号、全局），再 up
      for (const k of ['lead', xiaoKey('lead'), 'vault.fp']) await db.query(`INSERT INTO core_settings (key, value, updated_at) VALUES ($1, '1'::jsonb, now())`, [k]);
      expect(await migrate(db)).toEqual(['0037_rls_p1_settings.sql']);
      expect(await forced()).toBe(true);
      const { rows } = await systemScoped(db).query<{ key: string; user_id: string }>('SELECT key, user_id FROM core_settings ORDER BY key');
      expect(rows.map((r) => [r.key, r.user_id])).toEqual([['lead', 'owner'], [xiaoKey('lead'), XIAO], ['vault.fp', 'owner']].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    } finally {
      await db.close();
    }
  });
});
