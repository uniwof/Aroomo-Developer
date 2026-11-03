-- D206 模块：收件箱 inbox_items 开启 RLS（A+），模板同 0019（B1）。
-- 数据回填必须在 ENABLE 之前：FORCE 之后迁移角色同样受 RLS 约束，UPDATE 会悄悄改 0 行（B4）。
-- 所有者的旧条目 user_id 为空，先改成 'owner'。
UPDATE inbox_items SET user_id = 'owner' WHERE user_id IS NULL;
ALTER TABLE inbox_items ALTER COLUMN user_id SET DEFAULT 'owner';
ALTER TABLE inbox_items ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox_items ADD CONSTRAINT inbox_items_user_id_nonempty CHECK (user_id <> '');
CREATE POLICY inbox_items_user ON inbox_items
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY inbox_items_system_read ON inbox_items FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
