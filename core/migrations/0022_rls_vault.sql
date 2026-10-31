-- D206 模块：保险箱表 vault_secrets 开启 RLS（A+）。规则同 0019：user_id = app.user_id，或系统范围。
ALTER TABLE vault_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY vault_secrets_isolation ON vault_secrets
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');
