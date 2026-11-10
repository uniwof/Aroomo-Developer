-- 回退 0039：恢复 DEFAULT 'owner'。执行身份：表所有者 aroomo_core。
BEGIN;
ALTER TABLE core_settings ALTER COLUMN user_id SET DEFAULT 'owner';
COMMIT;
