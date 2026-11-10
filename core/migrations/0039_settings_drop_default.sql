-- #345：0037 回填 core_settings.user_id 之后去掉 DEFAULT 'owner'（A+），防止漏写 user_id 的插入静默落到所有者名下。
-- 回退：migrations/down/0039_settings_drop_default.down.sql。
ALTER TABLE core_settings ALTER COLUMN user_id DROP DEFAULT;
