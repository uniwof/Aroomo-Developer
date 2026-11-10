-- #380（#369 负责人第 2 轮非必改，A+）：0037 回填 core_settings.user_id 之后去掉 DEFAULT 'owner'。
-- 应用侧 PgSettingsStore.set 每次都显式写 user_id；去掉默认值后，任何漏写 user_id 的 INSERT 直接 NOT NULL 报错，
-- 不再悄悄落到所有者名下（CHECK core_settings_user_id_matches_key 只挡「前缀键写成 owner」，挡不住「无前缀键漏写」）。
-- 回退：migrations/down/0039_core_settings_drop_default.down.sql。不动数据。
ALTER TABLE core_settings ALTER COLUMN user_id DROP DEFAULT;
