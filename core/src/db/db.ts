/**
 * Core 自己的数据库访问层（PRODUCT §11.2；DECISIONS D45：Core 的业务数据只存在 aroomo_core 库）。
 *
 * 只定义最小接口，生产用 node-postgres（pg.Pool），测试用 PGlite（真 PostgreSQL 编译成 WASM）
 * 或 CI 里的 PostgreSQL 服务容器，两者走同一套 SQL。
 */
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  /** 参数化查询（单条语句）。 */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** 执行多条语句（只用于迁移，不接受参数）。 */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** 在一个事务里执行 fn；fn 抛错则回滚。 */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgDbOptions {
  /** 指定 search_path（测试时每个用例一个 schema）。只允许 [a-z0-9_]。 */
  schema?: string;
  max?: number;
  /** D206：每个连接在启动参数里就设为这个应用角色（非表所有者、非超级用户），RLS 才对它生效。只允许 [a-z0-9_]。 */
  role?: string;
}

export function createPgDb(connectionString: string, opts: PgDbOptions = {}): Db {
  if (opts.schema !== undefined && !/^[a-z0-9_]+$/.test(opts.schema)) {
    throw new Error('schema 名只允许小写字母、数字、下划线');
  }
  if (opts.role !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(opts.role)) {
    throw new Error('角色名只允许小写字母、数字、下划线');
  }
  // D206：角色放进连接的启动参数（-c role=…），由服务器在握手时设置：角色不存在 / 无权切换时连接直接失败，
  // 不存在「先以表所有者身份建好连接、再异步 SET ROLE」的空窗。
  const startupOptions = [
    ...(opts.schema ? [`-c search_path=${opts.schema}`] : []),
    ...(opts.role ? [`-c role=${opts.role}`] : []),
  ].join(' ');
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ...(startupOptions ? { options: startupOptions } : {}),
  });

  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await c.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as T[] };
    },
    async exec(sql: string) {
      await c.query(sql);
    },
  });

  const base = wrap(pool);
  return {
    query: base.query,
    exec: base.exec,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: unknown;
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        let rollbackFailed = false;
        await client.query('ROLLBACK').catch(() => {
          rollbackFailed = true;
        });
        broken = rollbackFailed ? err : undefined;
        throw err;
      } finally {
        client.release(broken as Error | undefined);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** 把数据库返回的时间统一成 Date（pg / PGlite 都返回 Date，这里兜底字符串）。 */
export function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

export function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}
