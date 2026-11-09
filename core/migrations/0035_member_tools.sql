-- 成员工具分配 v1 切片 1（docs/api/design-member-tools-v1.md；Poke 清单第 9 项后半）。回退：migrations/down/0035_member_tools.down.sql
-- 只存引用：成员 × 工具网关里的工具名 + 分配时间。不存 Key、工具配置、工具定义；名字、风险、可用与否当场从网关读。
-- 按 user_id 隔离（ENABLE + FORCE RLS，模板同 0033）。成员彻底删除时一起删（软删除保留）。去掉分配是真删行，历史在审计里。
CREATE TABLE member_tools (
  user_id     text        NOT NULL CONSTRAINT member_tools_user_id_nonempty CHECK (user_id <> ''),
  member_id   text        NOT NULL,
  tool        text        NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]{1,63}$'),
  assigned_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, member_id, tool),
  FOREIGN KEY (user_id, member_id) REFERENCES members (user_id, id) ON DELETE CASCADE
);
ALTER TABLE member_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY member_tools_user ON member_tools
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY member_tools_system_read ON member_tools FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
