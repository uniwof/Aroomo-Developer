-- 回退 0031_member_profile.sql：删掉成员资料三列（数据随之丢弃）。
ALTER TABLE members DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS system_prompt, DROP COLUMN IF EXISTS avatar;
DELETE FROM core_schema_migrations WHERE version = '0031_member_profile.sql';
