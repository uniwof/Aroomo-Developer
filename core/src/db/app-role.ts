/**
 * D206：应用连接数据库的角色不能是表所有者、不能是超级用户 / BYPASSRLS，否则 RLS 形同虚设。
 *
 * 做法（不新增密码）：登录角色 aroomo_core 是表所有者，只用来跑迁移；
 * 应用连接池建立连接后 SET ROLE 到 NOLOGIN 角色（默认 aroomo_core_app，由数据库初始化脚本创建并授予 aroomo_core）。
 * 启动时由所有者给应用角色授 DML 权限（幂等），再检查应用连接确实受 RLS 约束，不满足就拒绝启动。
 */
import type { Queryable } from './db.js';

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

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
  `);
}

export interface AppRoleCheck {
  currentUser: string;
  superuser: boolean;
  bypassRls: boolean;
  ownedTables: number;
}

export async function checkAppRole(app: Queryable): Promise<AppRoleCheck> {
  const { rows } = await app.query<{ u: string; su: boolean; br: boolean; owned: number }>(
    `SELECT current_user AS u, r.rolsuper AS su, r.rolbypassrls AS br,
            (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = current_schema() AND t.tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r) throw new Error('查不到当前数据库角色');
  return { currentUser: r.u, superuser: r.su, bypassRls: r.br, ownedTables: r.owned };
}

/** 不受 RLS 约束就抛错（启动时调用）。 */
export async function assertAppRoleSafe(app: Queryable): Promise<AppRoleCheck> {
  const c = await checkAppRole(app);
  if (c.superuser || c.bypassRls) throw new Error(`应用数据库角色 ${c.currentUser} 是超级用户或可绕过 RLS，拒绝启动（D206）`);
  if (c.ownedTables > 0) throw new Error(`应用数据库角色 ${c.currentUser} 是 ${c.ownedTables} 张表的所有者，拒绝启动（D206）`);
  return c;
}
