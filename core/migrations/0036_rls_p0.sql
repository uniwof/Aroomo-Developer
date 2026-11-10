-- D206 / #345 P0：给 client_tokens、user_sessions、exec_tasks、exec_takeovers、executors、confirm_challenges 开 RLS（ENABLE + FORCE，A+）。
-- 回退：migrations/down/0036_rls_p0.down.sql。模板同 0024：<表>_user（ALL，user_id = app.user_id）+ <表>_system_read（只读，app.system_scope=on）。
-- 数据回填必须在 ENABLE 之前：FORCE 之后迁移角色同样受 RLS 约束，UPDATE 会悄悄改 0 行。
-- 登录前的查询（按 token_hash 找令牌 / 会话）还没有 app.user_id，应用侧用 systemScoped 只读，找到后的所有写入都切回 userScoped。

-- confirm_challenges 原来没有 user_id：按 actor 换算（owner → 'owner'；user:<id> → <id>；其他原样）。
-- 换算规则只写一处：函数 confirm_challenge_scope(actor)。回填用它，CHECK 也用它（负责人必改 M1）：
-- 应用侧 TS 的 challengeScope 写进来的 user_id 和这条规则不一致，数据库直接拒（core/test/rls-p0.test.ts 有等价性测试和反向用例）。
CREATE FUNCTION confirm_challenge_scope(actor text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT CASE
    WHEN actor = 'owner' THEN 'owner'
    WHEN left(actor, 5) = 'user:' AND length(actor) > 5 THEN substr(actor, 6)
    ELSE actor END $$;
ALTER TABLE confirm_challenges ADD COLUMN user_id text;
UPDATE confirm_challenges SET user_id = confirm_challenge_scope(actor);
ALTER TABLE confirm_challenges ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE confirm_challenges ADD CONSTRAINT confirm_challenges_user_id_nonempty CHECK (user_id <> '');
ALTER TABLE confirm_challenges ADD CONSTRAINT confirm_challenges_user_id_from_actor CHECK (user_id = confirm_challenge_scope(actor));

-- 其余表的 user_id 已是 NOT NULL；非空串 CHECK 用 NOT VALID：新行立刻受约束，旧数据里若有空串不会让迁移失败。
-- 空串行用户范围看不见，但系统范围看得见：系统范围的查询一律带 user_id <> ''（M3）。上生产前清理（#229）并补 VALIDATE CONSTRAINT 迁移。
ALTER TABLE client_tokens ADD CONSTRAINT client_tokens_user_id_nonempty CHECK (user_id <> '') NOT VALID;
ALTER TABLE exec_tasks ADD CONSTRAINT exec_tasks_user_id_nonempty CHECK (user_id <> '') NOT VALID;
ALTER TABLE exec_takeovers ADD CONSTRAINT exec_takeovers_user_id_nonempty CHECK (user_id <> '') NOT VALID;
ALTER TABLE executors ADD CONSTRAINT executors_user_id_nonempty CHECK (user_id <> '') NOT VALID;

ALTER TABLE client_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY client_tokens_user ON client_tokens
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY client_tokens_system_read ON client_tokens FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE exec_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY exec_tasks_user ON exec_tasks
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY exec_tasks_system_read ON exec_tasks FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE exec_takeovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec_takeovers FORCE ROW LEVEL SECURITY;
CREATE POLICY exec_takeovers_user ON exec_takeovers
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY exec_takeovers_system_read ON exec_takeovers FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE executors ENABLE ROW LEVEL SECURITY;
ALTER TABLE executors FORCE ROW LEVEL SECURITY;
CREATE POLICY executors_user ON executors
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY executors_system_read ON executors FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE confirm_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirm_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY confirm_challenges_user ON confirm_challenges
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY confirm_challenges_system_read ON confirm_challenges FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_user ON user_sessions
  USING (user_id::text = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id::text = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_sessions_system_read ON user_sessions FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
