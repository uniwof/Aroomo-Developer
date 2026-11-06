/**
 * D206：应用连接数据库的角色不能是表所有者、不能是超级用户 / BYPASSRLS，否则 RLS 形同虚设。
 *
 * 做法：登录角色 aroomo_core 是表所有者，只用来跑迁移和授权；启动时由所有者给应用角色授 DML 权限（幂等），
 * 再检查应用连接确实受 RLS 约束，不满足就拒绝启动。
 * - 推荐（D213 第 13 项，阶段 3 生产必须）：应用角色 aroomo_core_app 自己能登录（scripts/create-app-db-role.sh 建），
 *   不是所有者的成员，会话里 SET ROLE / RESET ROLE 都回不到所有者。
 * - 旧做法：所有者登录后在启动参数里 role=aroomo_core_app；登录身份仍是所有者，会话里 SET ROLE 所有者就能关掉 FORCE，
 *   只在 requireLogin=false 时放行。
 */
import type { Queryable } from './db.js';

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * 只追加的表：应用角色不能 DELETE（UPDATE 由各表触发器拒绝；audit_log 另外收回 UPDATE）。
 * 外键 ON DELETE CASCADE 照样能删到它们：级联由数据库以表所有者身份执行，不检查调用者的 DELETE 权限。
 * 还没建的表（迁移在后面的分支里）跳过。负责人 11-05 第二批必改 3。
 */
export const APPEND_ONLY_TABLES = ['audit_log', 'conversation_messages', 'run_steps'] as const;

/** 以表所有者身份执行：给应用角色授当前 schema 全部表 / 序列的 DML 权限，并覆盖以后新建的表。 */
export async function grantAppRole(owner: Queryable, role: string): Promise<void> {
  if (!ROLE_RE.test(role)) throw new Error('角色名只允许小写字母、数字、下划线');
  const { rows } = await owner.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists', [role]);
  if (!rows[0]?.exists) throw new Error(`数据库角色 ${role} 不存在：请先按 docs/ops/RLS.md 创建`);
  // 授权范围 = 当前 schema（生产是 public；测试每个用例一个 schema）。库名 / schema 名经校验后才拼进 SQL
  const { rows: names } = await owner.query<{ db: string; sc: string }>('SELECT current_database() AS db, current_schema() AS sc');
  const { db, sc } = names[0] ?? { db: '', sc: '' };
  if (!ROLE_RE.test(db) || !ROLE_RE.test(sc)) throw new Error('库名 / schema 名只允许小写字母、数字、下划线');
  await owner.exec(`
    GRANT CONNECT ON DATABASE ${db} TO ${role};
    GRANT USAGE ON SCHEMA ${sc} TO ${role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${sc} TO ${role};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${sc} TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${sc} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${sc} GRANT USAGE, SELECT ON SEQUENCES TO ${role};
    -- 红线：审计日志只能追加；迁移记录应用不得改。授权之后每次启动都收回（上面的 ALL TABLES 会把它们带上）
    REVOKE UPDATE, DELETE ON audit_log FROM ${role};
    REVOKE INSERT, UPDATE, DELETE ON core_schema_migrations FROM ${role};
    -- TRUNCATE 不走行级策略、也不触发 DELETE 触发器：应用角色一律没有（上面本来就没授，这里显式收回，防以前手工授过）
    REVOKE TRUNCATE ON ALL TABLES IN SCHEMA ${sc} FROM ${role};
  `);
  for (const t of APPEND_ONLY_TABLES) {
    const { rows: r } = await owner.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [t]);
    if (r[0]?.ok) await owner.exec(`REVOKE DELETE ON ${t} FROM ${role};`);
  }
}

export interface AppRoleCheck {
  currentUser: string;
  /** 登录身份：会话里总能 SET ROLE 回到它 */
  sessionUser: string;
  /** 登录身份能变成的表所有者（必须为空，否则会话里 RESET ROLE / SET ROLE 就能关掉 RLS） */
  ownerReachable: string[];
  /** 开了 RLS 但没 FORCE 的表（必须为空） */
  notForced: string[];
  superuser: boolean;
  bypassRls: boolean;
  ownedTables: number;
  /** 应用角色能 TRUNCATE 的表（必须为空） */
  truncatable: string[];
  /** 应用角色能 DELETE 的只追加表（必须为空） */
  appendOnlyDeletable: string[];
}

export async function checkAppRole(app: Queryable): Promise<AppRoleCheck> {
  const { rows } = await app.query<{
    u: string; s: string; su: boolean; br: boolean; owned: number; tr: string[] | null; del: string[] | null; reach: string[] | null; nf: string[] | null;
  }>(
    `SELECT current_user AS u, session_user AS s, r.rolsuper AS su, r.rolbypassrls AS br,
            (SELECT array_agg(DISTINCT t.tableowner::text ORDER BY t.tableowner::text) FROM pg_tables t
              WHERE t.schemaname = current_schema() AND pg_has_role(session_user, t.tableowner, 'MEMBER')) AS reach,
            (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
              WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity) AS nf,
            (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = current_schema() AND t.tableowner = current_user) AS owned,
            (SELECT array_agg(t.tablename::text ORDER BY t.tablename) FROM pg_tables t
              WHERE t.schemaname = current_schema() AND has_table_privilege(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename), 'TRUNCATE')) AS tr,
            (SELECT array_agg(t.tablename::text ORDER BY t.tablename) FROM pg_tables t
              WHERE t.schemaname = current_schema() AND t.tablename = ANY($1::text[])
                AND has_table_privilege(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename), 'DELETE')) AS del
       FROM pg_roles r WHERE r.rolname = current_user`,
    [[...APPEND_ONLY_TABLES]],
  );
  const r = rows[0];
  if (!r) throw new Error('查不到当前数据库角色');
  return {
    currentUser: r.u, sessionUser: r.s, ownerReachable: r.reach ?? [], notForced: r.nf ?? [], superuser: r.su, bypassRls: r.br, ownedTables: r.owned, truncatable: r.tr ?? [], appendOnlyDeletable: r.del ?? [] };
}

export interface AppRoleAssertOptions {
  /** 当前角色必须是这个名字（防 .env 写错连成别的角色） */
  expectRole?: string;
  /** 必须是独立登录的应用角色：登录身份就是应用角色，且变不成任何表所有者（D213 第 13 项） */
  requireLogin?: boolean;
}

/** 不受 RLS 约束就抛错（启动时调用）。 */
export async function assertAppRoleSafe(app: Queryable, opts: AppRoleAssertOptions = {}): Promise<AppRoleCheck> {
  const c = await checkAppRole(app);
  if (opts.expectRole !== undefined && c.currentUser !== opts.expectRole) {
    throw new Error(`应用数据库连接的角色是 ${c.currentUser}，不是 ${opts.expectRole}，拒绝启动（D206）`);
  }
  if (opts.requireLogin && (c.sessionUser !== c.currentUser || c.ownerReachable.length > 0)) {
    throw new Error(
      `应用数据库连接的登录身份 ${c.sessionUser} 能变成表所有者 ${c.ownerReachable.join(', ') || c.sessionUser}（会话里一句 SET ROLE 就能回到所有者、关掉 RLS），拒绝启动（D213 第 13 项）`,
    );
  }
  if (c.notForced.length > 0) throw new Error(`这些表开了 RLS 但没有 FORCE：${c.notForced.join(', ')}，拒绝启动（D206）`);
  if (c.superuser || c.bypassRls) throw new Error(`应用数据库角色 ${c.currentUser} 是超级用户或可绕过 RLS，拒绝启动（D206）`);
  if (c.ownedTables > 0) throw new Error(`应用数据库角色 ${c.currentUser} 是 ${c.ownedTables} 张表的所有者，拒绝启动（D206）`);
  if (c.truncatable.length > 0) throw new Error(`应用数据库角色 ${c.currentUser} 能 TRUNCATE ${c.truncatable.join(', ')}，拒绝启动（D206）`);
  if (c.appendOnlyDeletable.length > 0) throw new Error(`应用数据库角色 ${c.currentUser} 能删除只追加的表 ${c.appendOnlyDeletable.join(', ')}，拒绝启动（D206）`);
  return c;
}
