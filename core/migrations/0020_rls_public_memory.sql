-- D206 第 2 个模块：公共记忆（public_memory + 历史版本）开启行级安全，规则同 0019。
ALTER TABLE public_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY public_memory_isolation ON public_memory
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');

ALTER TABLE public_memory_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_memory_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY public_memory_versions_isolation ON public_memory_versions
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');
