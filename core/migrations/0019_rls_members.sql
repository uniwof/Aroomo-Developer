-- D206 第 1 个模块：成员表开启行级安全（RLS）。
-- 规则：只能看到 / 写入 user_id = current_setting('app.user_id') 的行；Core 在每个事务开头 set_config(…, true)。
-- 不设置 app.user_id 时 current_setting(…, true) 为 NULL 或 ''，比较结果不为真 → 查询为空、写入被拒（默认拒绝）。
-- app.system_scope = 'on' 只给跨用户的系统任务（core/src/db/scope.ts 的 systemScoped），业务请求不用。
-- FORCE：表的所有者（当前 Core 连接角色 aroomo_core）同样受约束；只有超级用户 / BYPASSRLS 角色能绕过。
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_isolation ON members
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.system_scope', true) = 'on');
