-- D206 / #345 P2：给 users、user_invites、audit_log 开 ENABLE + FORCE（A+）。
-- 回退：migrations/down/0038_rls_p2.down.sql。不加列、不回填，只开策略（三张表现有数据不动）。
-- 这三张表都在「登录前 / 无账号」的路径上用，所以和 P0/P1 不一样的地方写在下面：
--   users：本人读写自己那一行（id::text = app.user_id，注册新账号时 id 已知）+ 系统只读（按邮箱登录、管理员列表）。
--   user_invites：邀请码持有人注册时还没有账号 → 按码哈希查找 / 标记已用走系统范围（SELECT + UPDATE）；
--     创建与管理员列表按创建人（created_by = 'owner' 或 'user:<id>'，与 app.user_id 对得上）。
--   audit_log：任何路径都要能追加（含登录失败、系统任务），所以 INSERT 不要求范围；读只给系统范围（GET /api/audit 只给所有者）。
--     应用侧 INSERT 不再 RETURNING（RETURNING 需要 SELECT 权限）。触发器仍拒绝 UPDATE / DELETE / TRUNCATE。

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id::text = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (id::text = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY users_system_read ON users FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE user_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY user_invites_creator ON user_invites
  USING (NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
         AND created_by IN (current_setting('app.user_id', true), 'user:' || current_setting('app.user_id', true)))
  WITH CHECK (NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
         AND created_by IN (current_setting('app.user_id', true), 'user:' || current_setting('app.user_id', true)));
CREATE POLICY user_invites_system_read ON user_invites FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
CREATE POLICY user_invites_system_redeem ON user_invites FOR UPDATE
  USING (current_setting('app.system_scope', true) = 'on')
  WITH CHECK (current_setting('app.system_scope', true) = 'on');

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_append ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_log_system_read ON audit_log FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
