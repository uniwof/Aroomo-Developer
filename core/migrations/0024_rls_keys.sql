-- D206 模块：provider_keys 开启 RLS（A+）。所有者的旧条目 user_id 为空，先改成 'owner'。
UPDATE provider_keys SET user_id = 'owner' WHERE user_id IS NULL;
ALTER TABLE provider_keys ALTER COLUMN user_id SET DEFAULT 'owner';
ALTER TABLE provider_keys ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_keys_isolation ON provider_keys
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');
