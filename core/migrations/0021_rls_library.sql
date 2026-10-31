-- D206 第 3 个模块：私人资源库 library_items 开启行级安全，规则同 0019（D219：私人资源库按 RLS 隔离）。
ALTER TABLE library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_items FORCE ROW LEVEL SECURITY;
CREATE POLICY library_items_isolation ON library_items
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');
