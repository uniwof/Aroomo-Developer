/**
 * D206 RLS 测试用数据库：迁移跑完后切到一个「非超级用户、非表所有者」的角色，
 * 和生产里应用连接的角色一样受 RLS 约束（超级用户会绕过 RLS，测试不能用它验证）。
 * 每个开启 RLS 的模块都用 rlsTargets 加两条测试：不设 app.user_id 为空；设为小号看不到所有者的行。
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Db, Queryable } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { openPglite } from './db.js';

export const RLS_APP_ROLE = 'aroomo_rls_app_test';

const grantSql = (schema: string) => `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_APP_ROLE}') THEN
      CREATE ROLE ${RLS_APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA ${schema} TO ${RLS_APP_ROLE};
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${RLS_APP_ROLE};
`;

export interface RlsTarget {
  name: string;
  /** 已迁移、已切到应用角色的全新库 */
  open(): Promise<Db>;
}

const pgliteRls: RlsTarget = {
  name: 'pglite',
  async open() {
    const db = await openPglite();
    await db.exec(grantSql('public'));
    await db.exec(`SET ROLE ${RLS_APP_ROLE}`);
    return db;
  },
};

function wrapClient(c: pg.Client): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return { rows: (await c.query(sql, params as unknown[] | undefined)).rows as T[] };
    },
    async exec(sql: string) {
      await c.query(sql);
    },
  };
}

function realPgRls(url: string): RlsTarget {
  return {
    name: 'postgres',
    async open() {
      const schema = `r_${randomBytes(6).toString('hex')}`;
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path = ${schema}`);
      const base = wrapClient(c);
      const db: Db = {
        ...base,
        async tx(fn) {
          await c.query('BEGIN');
          try {
            const out = await fn(base);
            await c.query('COMMIT');
            return out;
          } catch (err) {
            await c.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        },
        close: () => c.end(),
      };
      await migrate(db);
      await db.exec(grantSql(schema));
      await db.exec(`SET ROLE ${RLS_APP_ROLE}`);
      return db;
    },
  };
}

export const rlsTargets: RlsTarget[] = [
  pgliteRls,
  ...(process.env.CORE_TEST_DATABASE_URL ? [realPgRls(process.env.CORE_TEST_DATABASE_URL)] : []),
];
