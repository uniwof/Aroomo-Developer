/** D206：应用连接角色必须非超级用户、非 BYPASSRLS、非表所有者；启动时授权并自检。 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertAppRoleSafe, checkAppRole, grantAppRole } from '../src/db/app-role.js';
import { createPgDb } from '../src/db/db.js';
import { userScoped } from '../src/db/scope.js';
import { openPglite } from './helpers/db.js';

describe('应用数据库角色（PGlite）', () => {
  it('超级用户被拒；授权后切到应用角色通过自检，且受 RLS 约束', async () => {
    const db = await openPglite();
    try {
      await expect(assertAppRoleSafe(db)).rejects.toThrow(/超级用户/);
      await expect(grantAppRole(db, 'aroomo_core_app_missing')).rejects.toThrow(/不存在/);
      await db.exec('CREATE ROLE aroomo_core_app NOLOGIN');
      await grantAppRole(db, 'aroomo_core_app');
      await grantAppRole(db, 'aroomo_core_app'); // 幂等
      await db.query(`INSERT INTO members (user_id, id, name, created_at, updated_at) VALUES ('owner','m1','M1',now(),now())`);
      await db.exec('SET ROLE aroomo_core_app');
      expect(await assertAppRoleSafe(db)).toMatchObject({ currentUser: 'aroomo_core_app', superuser: false, bypassRls: false, ownedTables: 0 });
      expect((await db.query('SELECT id FROM members')).rows).toEqual([]);
      expect((await userScoped(db, 'owner').query('SELECT id FROM members')).rows).toEqual([{ id: 'm1' }]);
      // 红线：应用角色只能追加审计、不能改删；迁移记录表应用角色完全不能写
      await db.query(
        `INSERT INTO audit_log (id, ts, actor_type, actor_id, action, target_type, target_id, result) VALUES ('${randomUUID()}', now(), 'system', 's', 'a', 't', 'x', 'ok')`,
      );
      expect((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows).toEqual([{ n: 1 }]);
      await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied for table audit_log/);
      await expect(db.query(`UPDATE audit_log SET note = 'x'`)).rejects.toThrow(/permission denied for table audit_log/);
      await expect(db.query('DELETE FROM core_schema_migrations')).rejects.toThrow(/permission denied for table core_schema_migrations/);
      await expect(db.query(`INSERT INTO core_schema_migrations (version) VALUES ('9999_x.sql')`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  });

  it('表所有者（即使不是超级用户）被拒', async () => {
    const db = await openPglite();
    try {
      await db.query(`INSERT INTO members (user_id, id, name, created_at, updated_at) VALUES ('owner','m1','M1',now(),now())`);
      await db.exec('CREATE ROLE tbl_owner NOLOGIN; ALTER TABLE members OWNER TO tbl_owner; SET ROLE tbl_owner');
      // FORCE 下表所有者同样受 RLS 约束：不设 app.user_id 时什么都看不到
      expect((await db.query('SELECT id FROM members')).rows).toEqual([]);
      expect((await checkAppRole(db)).ownedTables).toBe(1);
      await expect(assertAppRoleSafe(db)).rejects.toThrow(/所有者/);
    } finally {
      await db.close();
    }
  });

  it('非法角色名在配置和授权时都被拒（防注入）', async () => {
    expect(() => loadConfig({ CORE_DB_APP_ROLE: 'x; DROP TABLE members' })).toThrow(/CORE_DB_APP_ROLE/);
    expect(loadConfig({ CORE_DB_APP_ROLE: 'aroomo_core_app' }).dbAppRole).toBe('aroomo_core_app');
    const db = await openPglite(false);
    try {
      await expect(grantAppRole(db, 'Bad-Role')).rejects.toThrow(/角色名/);
    } finally {
      await db.close();
    }
    expect(() => createPgDb('postgres://x/y', { role: 'a;b' })).toThrow(/角色名/);
  });
});

const url = process.env.CORE_TEST_DATABASE_URL;
describe.skipIf(!url)('应用数据库角色（真 PostgreSQL：连接启动参数设 role）', () => {
  it('角色不存在时查询直接报错，不会以登录角色继续执行', async () => {
    const app = createPgDb(url as string, { role: 'aroomo_role_does_not_exist', max: 2 });
    try {
      await expect(app.query('SELECT current_user')).rejects.toThrow(/does not exist/);
      await expect(app.tx((q) => q.query('SELECT 1'))).rejects.toThrow(/does not exist/);
    } finally {
      await app.close();
    }
  });

  it('createPgDb({ role }) 的每个连接都是应用角色，RLS 生效', async () => {
    const schema = `a_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}; SET search_path = ${schema}; CREATE TABLE t (user_id text NOT NULL, v text);
      ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON t USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
      INSERT INTO t VALUES ('owner','secret');
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aroomo_core_app_ci') THEN CREATE ROLE aroomo_core_app_ci NOLOGIN; END IF; END $$;
      GRANT USAGE ON SCHEMA ${schema} TO aroomo_core_app_ci; GRANT SELECT, INSERT ON t TO aroomo_core_app_ci;`);
    await admin.end();
    const app = createPgDb(url as string, { schema, role: 'aroomo_core_app_ci', max: 3 });
    try {
      const results = await Promise.all([1, 2, 3].map(() => app.query<{ u: string; n: number }>('SELECT current_user AS u, (SELECT count(*)::int FROM t) AS n')));
      for (const r of results) expect(r.rows[0]).toEqual({ u: 'aroomo_core_app_ci', n: 0 });
      expect((await userScoped(app, 'owner').query<{ v: string }>('SELECT v FROM t')).rows).toEqual([{ v: 'secret' }]);
    } finally {
      await app.close();
    }
  });
});
