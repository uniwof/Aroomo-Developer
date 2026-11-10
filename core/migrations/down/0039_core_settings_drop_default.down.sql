-- 回退 0039：恢复 core_settings.user_id 的 DEFAULT 'owner'（不动数据）。
-- 执行身份：表所有者 aroomo_core（见 docs/ops/RLS.md），用 psql -U aroomo_core -d aroomo_core -f 本文件 跑，不要用应用角色。
BEGIN;
ALTER TABLE core_settings ALTER COLUMN user_id SET DEFAULT 'owner';
DELETE FROM core_schema_migrations WHERE version = '0039_core_settings_drop_default.sql';
COMMIT;
