/**
 * 测试用数据库：
 * - 总是跑 PGlite（真 PostgreSQL 编译成 WASM，进程内，无需 Docker）；
 * - 设置了 CORE_TEST_DATABASE_URL（CI 里的 PostgreSQL 服务容器）时，再对真 PostgreSQL 跑一遍。
 * 每次 open() 都是一个全新的空库（PGlite 新实例 / 真 PG 新 schema），并已执行全部迁移。
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
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
    name: 'postgres',
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
