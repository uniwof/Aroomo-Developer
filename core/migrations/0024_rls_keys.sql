-- D206 模块：provider_keys 开启 RLS（A+），模板同 0019（B1）。
-- 数据回填必须在 ENABLE 之前：FORCE 之后迁移角色同样受 RLS 约束，UPDATE 会悄悄改 0 行（B4）。
-- 所有者的旧条目 user_id 为空，先改成 'owner'。
UPDATE provider_keys SET user_id = 'owner' WHERE user_id IS NULL;
ALTER TABLE provider_keys ALTER COLUMN user_id SET DEFAULT 'owner';
ALTER TABLE provider_keys ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_user_id_nonempty CHECK (user_id <> '');
CREATE POLICY provider_keys_user ON provider_keys
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY provider_keys_system_read ON provider_keys FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
