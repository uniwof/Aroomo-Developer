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
-- 创建人：只能是所有者（app.user_id = 'owner'，created_by = 'owner'）或在用的管理员（created_by = 'user:<本人 id>'，
-- users 里本人那行 role = 'admin' 且 status = 'active'；子查询受 users_self 约束，只看得到本人那行）。负责人第 1 轮 M2。
CREATE POLICY user_invites_creator ON user_invites
  USING ((current_setting('app.user_id', true) = 'owner' AND created_by = 'owner')
         OR (created_by = 'user:' || NULLIF(current_setting('app.user_id', true), '')
             AND EXISTS (SELECT 1 FROM users u WHERE u.id::text = current_setting('app.user_id', true) AND u.role = 'admin' AND u.status = 'active')))
  WITH CHECK ((current_setting('app.user_id', true) = 'owner' AND created_by = 'owner')
         OR (created_by = 'user:' || NULLIF(current_setting('app.user_id', true), '')
             AND EXISTS (SELECT 1 FROM users u WHERE u.id::text = current_setting('app.user_id', true) AND u.role = 'admin' AND u.status = 'active')));
CREATE POLICY user_invites_system_read ON user_invites FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
CREATE POLICY user_invites_system_redeem ON user_invites FOR UPDATE
  USING (current_setting('app.system_scope', true) = 'on')
  WITH CHECK (current_setting('app.system_scope', true) = 'on');
-- 任何范围的 UPDATE 都只能把 used_at 从 NULL 改成非 NULL，其余列一律不许动（防系统范围把邀请改成 admin、延长有效期、把已用改回未用）。负责人第 1 轮 M1。
CREATE FUNCTION user_invites_redeem_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR (to_jsonb(NEW) - 'used_at') IS DISTINCT FROM (to_jsonb(OLD) - 'used_at') THEN
    RAISE EXCEPTION 'user_invites: only used_at NULL -> NOT NULL is allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_invites_redeem_only BEFORE UPDATE ON user_invites
  FOR EACH ROW EXECUTE FUNCTION user_invites_redeem_only();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_append ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_log_system_read ON audit_log FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
-- RLS 开启后，非系统范围的 UPDATE / DELETE 看不到任何行，0001 的行级触发器不会触发（悄悄改 0 行）。
-- 加一个语句级触发器：任何范围的 UPDATE / DELETE 语句都直接报错（与 TRUNCATE 一致），负责人第 1 轮 M4。
CREATE TRIGGER audit_log_no_update_delete_stmt
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
