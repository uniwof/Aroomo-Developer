/**
 * D206：应用连接数据库的角色不能是表所有者、不能是超级用户 / BYPASSRLS，否则 RLS 形同虚设。
 *
 * 做法（不新增密码）：登录角色 aroomo_core 是表所有者，只用来跑迁移；
 * 应用连接池在连接启动参数里设 role=NOLOGIN 角色（默认 aroomo_core_app，由数据库初始化脚本创建并授予 aroomo_core）。
 * 启动时由所有者给应用角色授 DML 权限（幂等），再检查应用连接确实受 RLS 约束，不满足就拒绝启动。
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
  await owner.exec(`
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role};
    -- 红线：审计日志只能追加；迁移记录应用不得改。授权之后每次启动都收回（上面的 ALL TABLES 会把它们带上）
    REVOKE UPDATE, DELETE ON audit_log FROM ${role};
    REVOKE INSERT, UPDATE, DELETE ON core_schema_migrations FROM ${role};
    -- TRUNCATE 不走行级策略、也不触发 DELETE 触发器：应用角色一律没有（上面本来就没授，这里显式收回，防以前手工授过）
    REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${role};
  `);
  for (const t of APPEND_ONLY_TABLES) {
    const { rows: r } = await owner.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [t]);
    if (r[0]?.ok) await owner.exec(`REVOKE DELETE ON ${t} FROM ${role};`);
  }
}

export interface AppRoleCheck {
  currentUser: string;
  superuser: boolean;
  bypassRls: boolean;
  ownedTables: number;
  /** 应用角色能 TRUNCATE 的表（必须为空） */
  truncatable: string[];
  /** 应用角色能 DELETE 的只追加表（必须为空） */
  appendOnlyDeletable: string[];
}

export async function checkAppRole(app: Queryable): Promise<AppRoleCheck> {
  const { rows } = await app.query<{ u: string; su: boolean; br: boolean; owned: number; tr: string[] | null; del: string[] | null }>(
    `SELECT current_user AS u, r.rolsuper AS su, r.rolbypassrls AS br,
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
  return { currentUser: r.u, superuser: r.su, bypassRls: r.br, ownedTables: r.owned, truncatable: r.tr ?? [], appendOnlyDeletable: r.del ?? [] };
}

/** 不受 RLS 约束就抛错（启动时调用）。 */
export async function assertAppRoleSafe(app: Queryable): Promise<AppRoleCheck> {
  const c = await checkAppRole(app);
  if (c.superuser || c.bypassRls) throw new Error(`应用数据库角色 ${c.currentUser} 是超级用户或可绕过 RLS，拒绝启动（D206）`);
  if (c.ownedTables > 0) throw new Error(`应用数据库角色 ${c.currentUser} 是 ${c.ownedTables} 张表的所有者，拒绝启动（D206）`);
  if (c.truncatable.length > 0) throw new Error(`应用数据库角色 ${c.currentUser} 能 TRUNCATE ${c.truncatable.join(', ')}，拒绝启动（D206）`);
  if (c.appendOnlyDeletable.length > 0) throw new Error(`应用数据库角色 ${c.currentUser} 能删除只追加的表 ${c.appendOnlyDeletable.join(', ')}，拒绝启动（D206）`);
  return c;
}
