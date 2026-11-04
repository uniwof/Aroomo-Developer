-- D206 第 3 个模块：私人资源库 library_items 开启行级安全，模板同 0019（B1）。
ALTER TABLE library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_items FORCE ROW LEVEL SECURITY;
ALTER TABLE library_items ADD CONSTRAINT library_items_user_id_nonempty CHECK (user_id <> '');
CREATE POLICY library_items_user ON library_items
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY library_items_system_read ON library_items FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
