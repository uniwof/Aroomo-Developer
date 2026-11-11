/**
 * 测试用数据库：
 * - 总是跑 PGlite（真 PostgreSQL 编译成 WASM，进程内，无需 Docker）；
 * - 设置了 CORE_TEST_DATABASE_URL（CI 里的 PostgreSQL 服务容器）时，再对真 PostgreSQL 跑一遍。
 * 每次 open() 都是一个全新的空库（PGlite 新实例 / 真 PG 新 schema），并已执行全部迁移。
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { grantAppRole } from '../../src/db/app-role.js';
import { createPgDb, type Db, type Queryable } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';

export interface DbTarget {
  name: string;
  open(): Promise<Db>;
}

function wrapPglite(p: PGlite | { query: PGlite['query']; exec: PGlite['exec'] }): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await p.query<T>(sql, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    async exec(sql: string) {
      await p.exec(sql);
    },
  };
}

export async function openPglite(runMigrations = true): Promise<Db> {
  const p = new PGlite();
  const base = wrapPglite(p);
  const db: Db = {
    query: base.query,
    exec: base.exec,
    tx: (fn) => p.transaction((t) => fn(wrapPglite(t))),
    close: () => p.close(),
  };
  if (runMigrations) await migrate(db);
  return db;
}

const pgliteTarget: DbTarget = { name: 'pglite', open: () => openPglite() };

function realPgTarget(url: string): DbTarget {
  return {
    // #403：这条以服务容器的超级用户（aroomo_test）连接，RLS 被整体绕过，只证明 SQL 在真 PG 上能跑，
    // 不能当 RLS / 越权证据。要验 RLS 用下面的 appRoleDbTargets（应用角色，非超级用户、NOBYPASSRLS）。
    name: 'postgres-superuser',
    async open() {
      const schema = `t_${randomBytes(6).toString('hex')}`;
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.end();
      const db = createPgDb(url, { schema, max: 4 });
      await migrate(db);
      return db;
    },
  };
}

export const dbTargets: DbTarget[] = [
  pgliteTarget,
  ...(process.env.CORE_TEST_DATABASE_URL ? [realPgTarget(process.env.CORE_TEST_DATABASE_URL)] : []),
];

/** 应用角色：NOLOGIN、非超级用户、不能绕过 RLS、不是任何表的所有者（D206）。迁移和授权以表所有者身份做完再切过去。 */
export const APP_ROLE_TEST = 'aroomo_core_app';
const CREATE_APP_ROLE = `DO $$ BEGIN CREATE ROLE ${APP_ROLE_TEST} NOLOGIN NOSUPERUSER NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`;

/**
 * #403：以应用角色连接的数据库目标（受 RLS 约束，和生产一致）。
 * 要把 RLS 当证据的测试用它，不要用 dbTargets 里的 postgres-superuser。
 */
export const appRoleDbTargets: DbTarget[] = [
  {
    name: 'pglite-app-role',
    async open() {
      const db = await openPglite();
      await db.exec(CREATE_APP_ROLE);
      await grantAppRole(db, APP_ROLE_TEST);
      await db.exec(`SET ROLE ${APP_ROLE_TEST}`);
      return db;
    },
  },
  ...(process.env.CORE_TEST_DATABASE_URL
    ? [
        {
          name: 'postgres-app-role',
          async open() {
            const url = process.env.CORE_TEST_DATABASE_URL as string;
            const schema = `a_${randomBytes(6).toString('hex')}`;
            const admin = createPgDb(url, { max: 1 });
            await admin.exec(`CREATE SCHEMA ${schema}`);
            await admin.close();
            const owner = createPgDb(url, { schema, max: 1 });
            try {
              await migrate(owner);
              await owner.exec(CREATE_APP_ROLE);
              await grantAppRole(owner, APP_ROLE_TEST);
            } finally {
              await owner.close();
            }
            return createPgDb(url, { schema, max: 4, role: APP_ROLE_TEST });
          },
        } satisfies DbTarget,
      ]
    : []),
];

/** 固定、可拨动的假时钟。 */
export function fakeClock(start = '2026-10-27T00:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
    set(iso: string) {
      t = new Date(iso).getTime();
    },
  };
}

export const OWNER_TOKEN = 'placeholder-owner-token-0123456789abcdef';
export const TOKEN_SECRET = 'placeholder-token-secret-0123456789abcdef';
export const ownerAuth = { authorization: `Bearer ${OWNER_TOKEN}` };
