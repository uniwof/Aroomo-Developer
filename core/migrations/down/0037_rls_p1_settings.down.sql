-- 回退 0037：关掉 core_settings 的 RLS、删策略和约束、删 user_id 列（键名前缀还在，旧版本照常读写）。
-- 执行身份：表所有者 aroomo_core（见 docs/ops/RLS.md），用 psql -U aroomo_core -d aroomo_core -f 本文件 跑，不要用应用角色。
BEGIN;
DROP POLICY IF EXISTS core_settings_system_read ON core_settings;
DROP POLICY IF EXISTS core_settings_user ON core_settings;
ALTER TABLE core_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE core_settings DROP CONSTRAINT IF EXISTS core_settings_user_id_matches_key;
ALTER TABLE core_settings DROP COLUMN IF EXISTS user_id;
DELETE FROM core_schema_migrations WHERE version = '0037_rls_p1_settings.sql';
COMMIT;
