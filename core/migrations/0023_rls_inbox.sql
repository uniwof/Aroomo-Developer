-- D206 模块：收件箱 inbox_items 开启 RLS（A+）。所有者的旧条目 user_id 为空，先改成 'owner'。
UPDATE inbox_items SET user_id = 'owner' WHERE user_id IS NULL;
ALTER TABLE inbox_items ALTER COLUMN user_id SET DEFAULT 'owner';
ALTER TABLE inbox_items ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_items_isolation ON inbox_items
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');
