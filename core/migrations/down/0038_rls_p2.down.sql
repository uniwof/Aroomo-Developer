-- 回退 0038：关掉 users / user_invites / audit_log 的 RLS、删策略（表结构和数据不动）。
-- 执行身份：表所有者 aroomo_core（见 docs/ops/RLS.md），用 psql -U aroomo_core -d aroomo_core -f 本文件 跑，不要用应用角色。
BEGIN;
DROP POLICY IF EXISTS audit_log_system_read ON audit_log;
DROP POLICY IF EXISTS audit_log_append ON audit_log;
ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_invites_system_redeem ON user_invites;
DROP POLICY IF EXISTS user_invites_system_read ON user_invites;
DROP POLICY IF EXISTS user_invites_creator ON user_invites;
ALTER TABLE user_invites NO FORCE ROW LEVEL SECURITY;
ALTER TABLE user_invites DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_system_read ON users;
DROP POLICY IF EXISTS users_self ON users;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
DELETE FROM core_schema_migrations WHERE version = '0038_rls_p2.sql';
COMMIT;
