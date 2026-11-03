-- D206 第 4 个模块：保险箱 vault_secrets 开启行级安全（A+），模板同 0019（B1）。
ALTER TABLE vault_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_secrets ADD CONSTRAINT vault_secrets_user_id_nonempty CHECK (user_id <> '');
CREATE POLICY vault_secrets_user ON vault_secrets
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY vault_secrets_system_read ON vault_secrets FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
