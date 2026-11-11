/** D206 RLS：#345 P1 core_settings（迁移 0037，A+）：加 user_id 列，键名前缀 u<hex>. 换算成账号 id。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { PgSettingsStore, scopedSettings, settingsOwnerOf } from '../src/settings/store.js';
import { RLS_APP_ROLE, rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const OTHER = '00000000-0000-4000-8000-00000000b22d';
const T0 = new Date('2026-11-10T00:00:00Z');
const RLS = /row-level security/;
const xiaoKey = (k: string) => `u${XIAO.replaceAll('-', '')}.${k}`;
const REQUIRE_REAL_PG = process.env.CI === 'true' || process.env.CI === '1' || process.env.AROOMO_REQUIRE_REAL_PG === '1';
const MISMATCH = /设置键不属于声明的账号/;
const H = 'abcdef0123456789';
const hex = (n: number) => H.repeat(3).slice(0, n);
/** M2：TS（settingsOwnerOf）与 SQL（0037 回填 UPDATE + CHECK）换算的边界键，全部满足 0006 的键格式 ^[a-z][a-z0-9_.-]{0,63}$ */
const EDGE_KEYS = [
  'lead', 'u', 'u.', 'vault.fp', `u${hex(32)}`, `u${hex(32)}.`, `u${hex(32)}.x`, `u${hex(31)}.x`, `u${hex(33)}.x`,
  `u${'g'.repeat(32)}.x`, `xu${hex(32)}.x`, `u${hex(32)}-x`, `u${hex(32)}_x`, `u${hex(32)}..x`, `u${hex(32)}.u.x`,
  `u${'0'.repeat(32)}.x`, `u${'f'.repeat(32)}.${'z'.repeat(30)}`, xiaoKey('usage.limits'),
];

/** 以表所有者 / 超级用户身份做一段（跑回退、造旧数据），做完切回应用角色 */
async function asAdmin<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE');
  try {
    return await fn();
  } finally {
    await db.exec(`SET ROLE ${RLS_APP_ROLE}`);
  }
}

describe('M2 真 PG 必须在场（CI）', () => {
  it.runIf(REQUIRE_REAL_PG)('CI 下 rlsTargets 必须含真 PostgreSQL：rls-settings 在真 PG 上实际执行，不是跳过', () => {
    expect(rlsTargets.map((t) => t.name)).toContain('postgres');
  });
  if (!REQUIRE_REAL_PG && rlsTargets.length < 2) it.skip('本地没配 CORE_TEST_DATABASE_URL：只跑 PGlite（CI 里会失败）', () => {});
});

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
    await new PgSettingsStore(db, 'owner').set('lead', { memberId: 'm' }, T0);
    expect((await db.query('SELECT * FROM core_settings')).rows).toEqual([]);
    await expect(raw(db, 'k', 'owner')).rejects.toThrow(RLS);
  });

  it('小号看不到、改不了、删不了所有者的设置；冒充 owner 写入被拒', async () => {
    const db = await open();
    const s = new PgSettingsStore(db, 'owner');
    await s.set('lead', { memberId: 'owner-m' }, T0);
    await s.forAccount(XIAO).set(xiaoKey('lead'), { memberId: 'xiao-m' }, T0);
    const asXiao = userScoped(db, XIAO);
    expect((await asXiao.query<{ key: string }>('SELECT key FROM core_settings')).rows.map((r) => r.key)).toEqual([xiaoKey('lead')]);
    expect((await asXiao.query(`UPDATE core_settings SET value='{"hacked":true}' WHERE key='lead' RETURNING key`)).rows).toEqual([]);
    expect((await asXiao.query(`DELETE FROM core_settings WHERE key='lead' RETURNING key`)).rows).toEqual([]);
    await expect(raw(asXiao, 'other', 'owner')).rejects.toThrow(RLS);
    await expect(raw(asXiao, xiaoKey('x'), OTHER)).rejects.toThrow(RLS);
    await expect(asXiao.query(`UPDATE core_settings SET user_id='owner' WHERE key='${xiaoKey('lead')}'`)).rejects.toThrow(RLS);
    // 所有者的行原样
    expect(await s.get('lead')).toEqual({ memberId: 'owner-m' });
    expect(await s.forAccount(XIAO).get(xiaoKey('lead'))).toEqual({ memberId: 'xiao-m' });
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
    const s = new PgSettingsStore(db, 'owner');
    const owner = scopedSettings(s, 'owner');
    const xiao = scopedSettings(s, XIAO);
    const other = scopedSettings(s, OTHER);
    await owner.set('usage.limits', { n: 1 }, T0);
    await xiao.set('usage.limits', { n: 2 }, T0);
    await xiao.set('usage.limits', { n: 3 }, T0); // 覆盖
    expect(await owner.get('usage.limits')).toEqual({ n: 1 });
    expect(await xiao.get('usage.limits')).toEqual({ n: 3 });
    expect(await other.get('usage.limits')).toBeNull();
    const rows = (await systemScoped(db).query<{ user_id: string; key: string }>('SELECT user_id, key FROM core_settings ORDER BY key COLLATE "C"')).rows;
    expect(rows).toEqual([{ user_id: XIAO, key: xiaoKey('usage.limits') }, { user_id: 'owner', key: 'usage.limits' }].sort((a, b) => (a.key < b.key ? -1 : 1)));
  });

  it('M1 归属账号由调用方声明：键名换算的账号和声明不一致就抛错，不会自动切到别人的范围', async () => {
    const db = await open();
    const s = new PgSettingsStore(db, 'owner');
    await s.forAccount(XIAO).set(xiaoKey('lead'), { memberId: 'xiao-m' }, T0);
    // 所有者范围（含 scopedSettings(s,'owner') 原样返回的 store）拿到拼出来的小号键：读写都抛错
    await expect(s.get(xiaoKey('lead'))).rejects.toThrow(MISMATCH);
    await expect(s.set(xiaoKey('lead'), { memberId: 'hacked' }, T0)).rejects.toThrow(MISMATCH);
    await expect(scopedSettings(s, 'owner').get(xiaoKey('lead'))).rejects.toThrow(MISMATCH);
    await expect(scopedSettings(s, 'owner').set(xiaoKey('x'), 1, T0)).rejects.toThrow(MISMATCH);
    // 小号范围拿到无前缀（所有者）的键、或别人的键：抛错
    await expect(s.forAccount(XIAO).get('lead')).rejects.toThrow(MISMATCH);
    await expect(s.forAccount(XIAO).set(`u${OTHER.replaceAll('-', '')}.lead`, 1, T0)).rejects.toThrow(MISMATCH);
    // scopedSettings 按传入的账号声明（大小写、连字符写法不同也换算成同一账号）
    expect(await scopedSettings(s, XIAO.toUpperCase()).get('lead')).toEqual({ memberId: 'xiao-m' });
    // 被拒的写入一行都没落库
    const rows = (await systemScoped(db).query<{ user_id: string; key: string; value: unknown }>('SELECT user_id, key, value FROM core_settings ORDER BY key COLLATE "C"')).rows;
    expect(rows).toEqual([{ user_id: XIAO, key: xiaoKey('lead'), value: { memberId: 'xiao-m' } }]);
  });

  it('M2 TS 与 SQL 换算等价：边界键按 settingsOwnerOf 写得进 CHECK，换成别的账号写不进', async () => {
    const db = await open();
    await asAdmin(db, async () => {
      for (const k of EDGE_KEYS) {
        const uid = settingsOwnerOf(k);
        await db.query(`INSERT INTO core_settings (user_id, key, value, updated_at) VALUES ($1, $2, '1'::jsonb, now())`, [uid, k]);
        const wrong = uid === 'owner' ? XIAO : 'owner';
        await expect(db.query(`UPDATE core_settings SET user_id = $1 WHERE key = $2`, [wrong, k])).rejects.toThrow(/core_settings_user_id_matches_key/);
      }
    });
  });

  it('漏写 WHERE 也只看到自己的行；系统范围只读、写不了', async () => {
    const db = await open();
    const s = new PgSettingsStore(db, 'owner');
    await s.set('a', 1, T0);
    await s.forAccount(XIAO).set(xiaoKey('a'), 2, T0);
    expect((await userScoped(db, XIAO).query('SELECT * FROM core_settings')).rows).toHaveLength(1);
    expect((await userScoped(db, 'owner').query('SELECT * FROM core_settings')).rows).toHaveLength(1);
    const sys = systemScoped(db);
    expect((await sys.query('SELECT * FROM core_settings')).rows).toHaveLength(2);
    expect((await sys.query(`UPDATE core_settings SET value='0'::jsonb RETURNING key`)).rows).toEqual([]);
    expect((await sys.query(`DELETE FROM core_settings RETURNING key`)).rows).toEqual([]);
    await expect(raw(sys, 'zz', 'owner')).rejects.toThrow(RLS);
  });
});

describe.each(rlsTargets)('迁移 0037 回退与回填（$name）', (target) => {
  it('M2 up → down → up：整份结构状态比对（RLS 开关、策略、约束、列、迁移记录），数据原样，边界键按 TS 同一规则回填', async () => {
    const db = await target.open();
    try {
      // 0039（#380）在 0037 之上去掉了 user_id 的 DEFAULT：先退 0039 再退 0037，up 时两个一起重跑
      const DOWN =
        readFileSync(fileURLToPath(new URL('../migrations/down/0039_core_settings_drop_default.down.sql', import.meta.url)), 'utf8') +
        readFileSync(fileURLToPath(new URL('../migrations/down/0037_rls_p1_settings.down.sql', import.meta.url)), 'utf8');
      const state = async () => ({
        rls: (await db.query<{ r: boolean; f: boolean }>(`SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = 'core_settings' AND relnamespace = current_schema()::regnamespace`)).rows.map((x) => [x.r, x.f]),
        policies: (await db.query<{ n: string }>(`SELECT policyname || ':' || cmd AS n FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'core_settings' ORDER BY 1`)).rows.map((x) => x.n),
        constraints: (await db.query<{ c: string }>(
          `SELECT co.conname AS c FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid WHERE cl.relnamespace = current_schema()::regnamespace AND cl.relname = 'core_settings' AND co.contype <> 'n' ORDER BY 1`,
        )).rows.map((x) => x.c),
        cols: (await db.query<{ c: string }>(
          `SELECT column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'core_settings' ORDER BY 1`,
        )).rows.map((x) => x.c),
        mig: (await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0037_rls_p1_settings.sql'`)).rows.length,
      });
      const data = async () => (await db.query<{ key: string; value: unknown; updated_at: Date }>('SELECT key, value, updated_at FROM core_settings ORDER BY key COLLATE "C"')).rows;
      await asAdmin(db, async () => {
        const UP = await state();
        expect(UP.rls).toEqual([[true, true]]);
        expect(UP.policies).toEqual(['core_settings_system_read:SELECT', 'core_settings_user:ALL']);
        expect(UP.constraints).toContain('core_settings_user_id_matches_key');
        expect(UP.cols).toContain('user_id:text:NO:'); // 0039：没有默认值
        expect(UP.mig).toBe(1);
        const DOWNED = {
          rls: [[false, false]],
          policies: [],
          constraints: UP.constraints.filter((c) => c !== 'core_settings_user_id_matches_key'),
          cols: UP.cols.filter((c) => !c.startsWith('user_id:')),
          mig: 0,
        };
        await db.exec(DOWN);
        expect(await state()).toEqual(DOWNED);
        // 回退状态下按旧版写法写边界键（所有者、小号、全局、各种似是而非的前缀），再 up
        for (const k of EDGE_KEYS) await db.query(`INSERT INTO core_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)`, [k, JSON.stringify({ k }), T0]);
        const before = await data();
        expect(await migrate(db)).toEqual(['0037_rls_p1_settings.sql', '0039_core_settings_drop_default.sql']);
        expect(await state()).toEqual(UP);
        expect(await data()).toEqual(before);
        // 再 down → 数据仍原样（down 只删列不删行）
        await db.exec(DOWN);
        expect(await state()).toEqual(DOWNED);
        expect(await data()).toEqual(before);
        expect(await migrate(db)).toEqual(['0037_rls_p1_settings.sql', '0039_core_settings_drop_default.sql']);
        expect(await state()).toEqual(UP);
      });
      const { rows } = await systemScoped(db).query<{ key: string; user_id: string }>('SELECT key, user_id FROM core_settings ORDER BY key COLLATE "C"');
      expect(rows).toEqual(EDGE_KEYS.slice().sort().map((key) => ({ key, user_id: settingsOwnerOf(key) })));
      expect(rows.filter((r) => r.user_id !== 'owner').map((r) => r.key).sort()).toEqual(
        [`u${hex(32)}.`, `u${hex(32)}.x`, `u${hex(32)}..x`, `u${hex(32)}.u.x`, `u${'0'.repeat(32)}.x`, `u${'f'.repeat(32)}.${'z'.repeat(30)}`, xiaoKey('usage.limits')].sort(),
      );
    } finally {
      await db.close();
    }
  });
});

/** 取 rejects 的错误对象（pg 与 pglite 的 DatabaseError 都带 code / column），没有拒绝就让测试失败 */
async function dbError(p: Promise<unknown>): Promise<{ code?: string; column?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; column?: string; message: string };
  }
  throw new Error('期望这条语句被数据库拒绝，但它成功了');
}

describe.each(rlsTargets)('迁移 0039 user_id 去掉默认值（#380，$name）', (target) => {
  /** 漏写 user_id 的旧写法：同一条 INSERT 在 up 状态必须 23502、在 down 状态必须成功 */
  const LEGACY_INSERT = `INSERT INTO core_settings (key, value, updated_at) VALUES ('lead', '1'::jsonb, now())`;

  it('M1(a)(b) 漏写 user_id 的 INSERT：up 时 SQLSTATE 23502 且列是 user_id；down 后同一条 INSERT 成功并落到 owner；再 up 又是 23502', async () => {
    const db = await target.open();
    try {
      const DOWN = readFileSync(fileURLToPath(new URL('../migrations/down/0039_core_settings_drop_default.down.sql', import.meta.url)), 'utf8');
      const def = async () =>
        (await db.query<{ d: string | null }>(
          `SELECT column_default AS d FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'core_settings' AND column_name = 'user_id'`,
        )).rows[0]?.d ?? null;
      await asAdmin(db, async () => {
        // up：没有默认值，漏写 → NOT NULL 违反（23502），报错的列就是 user_id，不是 RLS / CHECK / 权限
        const up1 = await dbError(db.query(LEGACY_INSERT));
        expect(up1.code).toBe('23502');
        expect(up1.column).toBe('user_id');
        expect(await def()).toBeNull();
        expect((await db.query('SELECT 1 FROM core_settings')).rows).toEqual([]);
        // down：默认值回来；同一条 INSERT 成功，落到 owner 名下（正向对照：证明上面的失败只因为 NOT NULL）
        await db.exec(DOWN);
        expect(await def()).toMatch(/'owner'/);
        await db.query(LEGACY_INSERT);
        expect((await db.query('SELECT user_id, key FROM core_settings')).rows).toEqual([{ user_id: 'owner', key: 'lead' }]);
        await db.query(`DELETE FROM core_settings WHERE key = 'lead'`);
        // 再 up：迁移记录已删，只重跑 0039；同一条 INSERT 又是 23502
        expect(await migrate(db)).toEqual(['0039_core_settings_drop_default.sql']);
        expect(await def()).toBeNull();
        const up2 = await dbError(db.query(LEGACY_INSERT));
        expect(up2.code).toBe('23502');
        expect(up2.column).toBe('user_id');
      });
    } finally {
      await db.close();
    }
  });

  it('M1(c) 应用角色（非超级用户、受 RLS）下，所有者和家人都经 scopedSettings 写设置：user_id 各自落对', async () => {
    const db = await target.open();
    try {
      // 当前连接就是测试用应用角色（不在 asAdmin 里），不是超级用户
      const who = (await db.query<{ u: string; s: boolean }>(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s`)).rows[0];
      expect(who).toEqual({ u: RLS_APP_ROLE, s: false });
      const store = new PgSettingsStore(db, 'owner');
      await scopedSettings(store, 'owner').set('usage.limits', { who: 'owner' }, T0);
      await scopedSettings(store, XIAO).set('usage.limits', { who: 'xiao' }, T0); // 家人前缀键 u<hex>.usage.limits
      expect(await scopedSettings(store, 'owner').get('usage.limits')).toEqual({ who: 'owner' });
      expect(await scopedSettings(store, XIAO).get('usage.limits')).toEqual({ who: 'xiao' });
      const own = (await userScoped(db, 'owner').query<{ user_id: string; key: string }>('SELECT user_id, key FROM core_settings')).rows;
      expect(own).toEqual([{ user_id: 'owner', key: 'usage.limits' }]);
      const fam = (await userScoped(db, XIAO).query<{ user_id: string; key: string }>('SELECT user_id, key FROM core_settings')).rows;
      expect(fam).toEqual([{ user_id: XIAO, key: xiaoKey('usage.limits') }]);
    } finally {
      await db.close();
    }
  });
});
