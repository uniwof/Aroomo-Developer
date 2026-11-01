-- D206 第 2 个模块：公共记忆（public_memory + 历史版本）开启行级安全，模板同 0019（B1）。
ALTER TABLE public_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_memory FORCE ROW LEVEL SECURITY;
ALTER TABLE public_memory ADD CONSTRAINT public_memory_user_id_nonempty CHECK (user_id <> '');
CREATE POLICY public_memory_user ON public_memory
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY public_memory_system_read ON public_memory FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE public_memory_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_memory_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public_memory_versions ADD CONSTRAINT public_memory_versions_user_id_nonempty CHECK (user_id <> '');
CREATE POLICY public_memory_versions_user ON public_memory_versions
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY public_memory_versions_system_read ON public_memory_versions FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

