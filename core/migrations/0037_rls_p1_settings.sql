-- D206 / #345 P1：core_settings 加 user_id 列并开 RLS（ENABLE + FORCE，A+）。
-- 回退：migrations/down/0037_rls_p1_settings.down.sql。模板同 0024：core_settings_user（ALL，user_id = app.user_id）+ core_settings_system_read（只读）。
-- 键名保留 u<32 位十六进制>. 前缀（回退到旧版本仍可读）；user_id 由键名前缀换算：u<hex>. → 标准 UUID 写法，否则 'owner'。
-- 数据回填必须在 ENABLE 之前：FORCE 之后迁移角色同样受 RLS 约束，UPDATE 会悄悄改 0 行。
ALTER TABLE core_settings ADD COLUMN user_id text NOT NULL DEFAULT 'owner';
UPDATE core_settings
   SET user_id = regexp_replace(substr(key, 2, 32), '^(.{8})(.{4})(.{4})(.{4})(.{12})$', '\1-\2-\3-\4-\5')
 WHERE key ~ '^u[a-f0-9]{32}\.';

-- user_id 必须和键名前缀一致：带前缀的键只能写在对应账号名下，其余只能是 'owner'（应用侧 PgSettingsStore 用同一套换算）。
ALTER TABLE core_settings ADD CONSTRAINT core_settings_user_id_matches_key CHECK (
  CASE WHEN key ~ '^u[a-f0-9]{32}\.'
       THEN user_id = regexp_replace(substr(key, 2, 32), '^(.{8})(.{4})(.{4})(.{4})(.{12})$', '\1-\2-\3-\4-\5')
       ELSE user_id = 'owner' END);

ALTER TABLE core_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY core_settings_user ON core_settings
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY core_settings_system_read ON core_settings FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
