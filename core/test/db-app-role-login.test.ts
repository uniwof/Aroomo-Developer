/**
 * D213 第 13 项 / 负责人阶段 3 硬条件：业务连接用独立可登录的应用角色 aroomo_core_app，
 * 不是表所有者、不是所有者角色的成员、没有 BYPASSRLS；会话里 RESET ROLE 也回不到所有者，RLS 关不掉。
 * 只在真 PostgreSQL 上有意义（PGlite 没有登录 / 口令），CI 必须真跑。
 * 每个用例一个全新的数据库（模仿生产：public schema 归表所有者，库对 PUBLIC 收回 CONNECT）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, toSafeJSON } from '../src/config.js';
import { assertAppRoleSafe, grantAppRole } from '../src/db/app-role.js';
import { createPgDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { userScoped } from '../src/db/scope.js';
import { PgWorkStore } from '../src/work/store.js';
import { openAppDb } from '../src/deps.js';

const url = process.env.CORE_TEST_DATABASE_URL;

function withUser(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

describe('配置：CORE_APP_DB_PASSWORD / CORE_DB_REQUIRE_APP_ROLE', () => {
  const base = { CORE_DATABASE_URL: 'postgresql://aroomo_core:pw@postgres:5432/aroomo_core' };
  it('设了应用口令就用同一主机和库、换成应用角色登录；口令不进日志视图', () => {
    const cfg = loadConfig({ ...base, CORE_DB_APP_ROLE: 'aroomo_core_app', CORE_APP_DB_PASSWORD: 'a'.repeat(64) });
    const u = new URL(cfg.appDatabaseUrl as string);
    expect([u.username, u.password, u.host, u.pathname]).toEqual(['aroomo_core_app', 'a'.repeat(64), 'postgres:5432', '/aroomo_core']);
    expect(JSON.stringify(toSafeJSON(cfg))).not.toContain('a'.repeat(64));
  });
  it('只设口令不设角色 → 拒绝启动；口令太短 → 拒绝启动', () => {
    expect(() => loadConfig({ ...base, CORE_APP_DB_PASSWORD: 'a'.repeat(64) })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CORE_DB_APP_ROLE: 'aroomo_core_app', CORE_APP_DB_PASSWORD: 'short' })).toThrow(/CORE_APP_DB_PASSWORD/);
  });
  it('CORE_DB_REQUIRE_APP_ROLE=true 但还是旧的 SET ROLE 方式（没有应用口令）→ 拒绝启动', () => {
    expect(() => loadConfig({ ...base, CORE_DB_REQUIRE_APP_ROLE: 'true' })).toThrow(/CORE_DB_REQUIRE_APP_ROLE/);
    expect(() => loadConfig({ ...base, CORE_DB_APP_ROLE: 'aroomo_core_app', CORE_DB_REQUIRE_APP_ROLE: 'true' })).toThrow(/CORE_DB_REQUIRE_APP_ROLE/);
    expect(loadConfig({ ...base, CORE_DB_APP_ROLE: 'aroomo_core_app', CORE_APP_DB_PASSWORD: 'a'.repeat(64), CORE_DB_REQUIRE_APP_ROLE: 'true' }).requireAppRole).toBe(true);
  });
});

describe.skipIf(!url)('独立可登录的应用角色（真 PostgreSQL）', () => {
  const tag = randomBytes(5).toString('hex');
  const dbName = `approle_${tag}`;
  const ownerRole = `own_${tag}`;
  const appRole = `app_${tag}`;
  const ownerPw = randomBytes(24).toString('hex');
  const appPw = randomBytes(32).toString('hex');
  let ownerUrl = '';
  let appUrl = '';
  let owner: Db;
  let app: Db;

  async function admin(sql: string, database?: string): Promise<void> {
    const c = new pg.Client({ connectionString: database ? withUser(url as string, new URL(url as string).username, decodeURIComponent(new URL(url as string).password), database) : url });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    // 和 scripts/create-app-db-role.sh 建出来的一样：LOGIN、NOINHERIT、非超级用户、无 BYPASSRLS、不建库不建角色
    await admin(`CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPw}'`);
    await admin(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${appPw}'`);
    await admin(`CREATE DATABASE ${dbName} OWNER ${ownerRole}`);
    await admin(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    ownerUrl = withUser(url as string, ownerRole, ownerPw, dbName);
    appUrl = withUser(url as string, appRole, appPw, dbName);
    owner = createPgDb(ownerUrl, { max: 2 });
    await migrate(owner);
    await grantAppRole(owner, appRole);
    app = createPgDb(appUrl, { max: 3 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin(`DROP ROLE IF EXISTS ${appRole}`);
    await admin(`DROP ROLE IF EXISTS ${ownerRole}`);
  });

  it('启动自检通过：登录身份就是应用角色、不是所有者也不是其成员、所有 RLS 表都 FORCE', async () => {
    const c = await app.tx((q) => assertAppRoleSafe(q, { expectRole: appRole, requireLogin: true }));
    expect(c).toMatchObject({ currentUser: appRole, sessionUser: appRole, superuser: false, bypassRls: false, ownedTables: 0, ownerReachable: [], notForced: [], truncatable: [], appendOnlyDeletable: [] });
  });

  it('应用角色关不掉 RLS：RESET ROLE 回不到所有者，SET ROLE 所有者、NO FORCE、DISABLE、删策略、row_security=off、TRUNCATE 全部失败', async () => {
    await app.tx(async (q) => {
      await q.exec('RESET ROLE');
      expect((await q.query('SELECT current_user AS u')).rows).toEqual([{ u: appRole }]);
    });
    await expect(app.query(`SET ROLE ${ownerRole}`)).rejects.toThrow(/permission denied/);
    const { rows } = await owner.query<{ t: string }>(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relrowsecurity ORDER BY 1`);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const { t } of rows) {
      await expect(app.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`), t).rejects.toThrow(/must be owner/);
      await expect(app.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`), t).rejects.toThrow(/must be owner/);
      await expect(app.query(`TRUNCATE ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(app.query('DROP POLICY members_user ON members')).rejects.toThrow(/must be owner|does not exist/);
    await expect(app.query(`CREATE POLICY open_all ON members USING (true)`)).rejects.toThrow(/must be owner/);
    await expect(app.query(`ALTER ROLE ${appRole} BYPASSRLS`)).rejects.toThrow(/permission denied/);
    await expect(
      app.tx(async (q) => {
        await q.exec('SET LOCAL row_security = off');
        await q.query('SELECT id FROM members');
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('跨账号：A 的成员和会话，B 和不带账号的连接都读不到、改不到、也不能冒名写给 A', async () => {
    const mid = `m-${tag}`;
    const cid = randomUUID();
    await userScoped(app, 'acct_a').query(`INSERT INTO members (user_id, id, name, created_at, updated_at) VALUES ('acct_a', $1, 'A的成员', now(), now())`, [mid]);
    await userScoped(app, 'acct_a').query(`INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ($1, 'acct_a', 'A的会话', now(), now())`, [cid]);
    expect((await userScoped(app, 'acct_a').query('SELECT id FROM members WHERE id = $1', [mid])).rows).toEqual([{ id: mid }]);

    const b = userScoped(app, 'acct_b');
    expect((await b.query('SELECT id FROM members')).rows).toEqual([]);
    expect((await b.query('SELECT id FROM members WHERE id = $1', [mid])).rows).toEqual([]);
    expect((await b.query('SELECT id FROM conversations WHERE id = $1', [cid])).rows).toEqual([]);
    expect((await b.query<{ id: string }>(`UPDATE members SET name = 'x' WHERE id = $1 RETURNING id`, [mid])).rows).toEqual([]);
    expect((await b.query<{ id: string }>('DELETE FROM members WHERE id = $1 RETURNING id', [mid])).rows).toEqual([]);
    await expect(b.query(`INSERT INTO members (user_id, id, name, created_at, updated_at) VALUES ('acct_a', 'forged-1', 'x', now(), now())`)).rejects.toThrow(/row-level security/);
    // 不设 app.user_id：什么都看不到
    expect((await app.query('SELECT count(*)::int AS n FROM members')).rows).toEqual([{ n: 0 }]);
    expect((await app.query('SELECT count(*)::int AS n FROM conversations')).rows).toEqual([{ n: 0 }]);
    // A 的数据原样还在
    expect((await userScoped(app, 'acct_a').query('SELECT name FROM members WHERE id = $1', [mid])).rows).toEqual([{ name: 'A的成员' }]);
  });

  it('负责人 #323：以应用角色登录，work_versions 能插（seq 自增）、预发布能转已发布，别的改不了、删不了', async () => {
    const store = new PgWorkStore(app);
    const now = new Date();
    const p = await store.createProject('acct_w', `p-${tag}`, [], now, 10);
    if (!p.ok) throw new Error('建项目失败');
    const v = { sourceType: 'github_release' as const, sourceRef: '1', label: 'v1', title: 't', actor: null, artifacts: [], sourceAt: now };
    expect(await store.addVersions('acct_w', p.project.id, [{ ...v, sourceState: 'prerelease' }], now)).toEqual({ added: 1, changed: 0 });
    expect(await store.addVersions('acct_w', p.project.id, [{ ...v, sourceState: 'published' }], now)).toEqual({ added: 0, changed: 1 });
    expect((await store.listVersions('acct_w', p.project.id, 10)).map((r) => r.sourceState)).toEqual(['published']);
    await expect(userScoped(app, 'acct_w').query(`UPDATE work_versions SET label = 'x'`)).rejects.toThrow(/不可变/);
    await expect(userScoped(app, 'acct_w').query('DELETE FROM work_versions')).rejects.toThrow(/permission denied/);
  });

  it('对照：旧的 SET ROLE 方式（登录身份是表所有者）一句 SET ROLE 就回到所有者、关掉 FORCE；自检在 requireLogin 下拒绝', async () => {
    await admin(`GRANT ${appRole} TO ${ownerRole}`);
    const legacy = createPgDb(ownerUrl, { role: appRole, max: 1 });
    try {
      await legacy.tx(async (q) => {
        expect((await q.query('SELECT current_user AS u')).rows).toEqual([{ u: appRole }]);
        await expect(assertAppRoleSafe(q, { expectRole: appRole, requireLogin: true })).rejects.toThrow(/SET ROLE/);
      });
      // 启动参数里的 role 是会话默认值，RESET ROLE 回到它；但登录身份是所有者，SET ROLE 所有者永远允许
      await legacy.tx(async (q) => {
        await q.exec(`SET LOCAL ROLE ${ownerRole}`);
        expect((await q.query('SELECT current_user AS u')).rows).toEqual([{ u: ownerRole }]);
        await q.exec('ALTER TABLE members NO FORCE ROW LEVEL SECURITY');
        expect((await q.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'members'")).rows).toEqual([{ f: false }]);
        throw new Error('rollback');
      }).catch((e: Error) => expect(e.message).toBe('rollback'));
      expect((await owner.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'members'")).rows).toEqual([{ f: true }]);
    } finally {
      await legacy.close();
      await admin(`REVOKE ${appRole} FROM ${ownerRole}`);
    }
  });

  it('应用角色被误加成所有者的成员 / 角色名对不上 → 自检拒绝启动', async () => {
    await admin(`GRANT ${ownerRole} TO ${appRole}`);
    try {
      const fresh = createPgDb(appUrl, { max: 1 });
      try {
        await expect(fresh.tx((q) => assertAppRoleSafe(q, { expectRole: appRole, requireLogin: true }))).rejects.toThrow(/所有者/);
      } finally {
        await fresh.close();
      }
    } finally {
      await admin(`REVOKE ${ownerRole} FROM ${appRole}`);
    }
    await expect(app.tx((q) => assertAppRoleSafe(q, { expectRole: 'aroomo_core_app', requireLogin: true }))).rejects.toThrow(/不是 aroomo_core_app/);
  });

  it('openAppDb：所有者跑迁移和授权，业务连接以应用角色登录并通过自检', async () => {
    const cfg = loadConfig({ CORE_DATABASE_URL: ownerUrl, CORE_DB_APP_ROLE: appRole, CORE_APP_DB_PASSWORD: appPw, CORE_DB_REQUIRE_APP_ROLE: 'true' });
    const { db, migrated } = await openAppDb(cfg);
    try {
      expect(migrated).toEqual([]);
      expect((await db.query('SELECT session_user AS s, current_user AS u')).rows).toEqual([{ s: appRole, u: appRole }]);
    } finally {
      await db.close();
    }
  });
});
