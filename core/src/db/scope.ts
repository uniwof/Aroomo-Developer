/**
 * D206 行级安全（RLS）的应用侧：每次访问业务表都在一个事务里先设置 app.user_id。
 *
 * - userScoped(db, userId)：返回同接口的 Db；每条 query 都包成
 *   BEGIN → set_config('app.user_id', userId, true) → 查询 → COMMIT，
 *   tx(fn) 在事务开头设置一次。is_local=true（等同 SET LOCAL），事务结束即失效，
 *   连接还回连接池后不会把上一个用户的身份带给下一个请求。
 * - systemScoped(db)：只给跨用户的系统任务（定时任务、按用户汇总）用，设置 app.system_scope=on。
 *   业务请求路径一律不得使用；新增调用处必须在 PR 说明里写明理由（负责人审）。
 * - 不设置任何一项时，开了 RLS 的表查询结果为空、写入被拒（默认拒绝）。
 *
 * 表上仍保留 WHERE user_id = …（双保险）；RLS 兜住「忘了写条件」的情况。
 */
import type { Db, Queryable } from './db.js';

const SET_USER = "SELECT set_config('app.user_id', $1, true)";
const SET_SYSTEM = "SELECT set_config('app.system_scope', 'on', true)";

function scoped(db: Db, setup: (q: Queryable) => Promise<unknown>): Db {
  const tx = <T>(fn: (q: Queryable) => Promise<T>): Promise<T> =>
    db.tx(async (q) => {
      await setup(q);
      return fn(q);
    });
  return {
    query: <T>(sql: string, params?: unknown[]) => tx((q) => q.query<T>(sql, params)),
    exec: (sql: string) => tx((q) => q.exec(sql)),
    tx,
    close: () => db.close(),
  };
}

export function userScoped(db: Db, userId: string): Db {
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('userScoped 需要非空 userId');
  return scoped(db, (q) => q.query(SET_USER, [userId]));
}

export function systemScoped(db: Db): Db {
  return scoped(db, (q) => q.query(SET_SYSTEM));
}
