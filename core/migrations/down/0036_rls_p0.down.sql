-- 回退前先备份（scripts/backup.sh；本文件会删 confirm_challenges.user_id 列，删了就没有了）。
-- 回退 0036：关掉六张表的 RLS、删策略、删约束，再删 confirm_challenges 的 user_id 列和换算函数（待确认的确认卡本来几分钟就过期，不丢要紧数据）。
-- 顺序：策略 / RLS → 约束 → 列 → 函数（先删约束再删列，CHECK 引用了函数，函数最后删）。
-- 执行身份：表所有者 aroomo_core（见 docs/ops/RLS.md），用 psql -U aroomo_core -d aroomo_core -f 本文件 跑，不要用应用角色。
BEGIN;
DROP POLICY IF EXISTS client_tokens_system_read ON client_tokens;
DROP POLICY IF EXISTS client_tokens_user ON client_tokens;
ALTER TABLE client_tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE client_tokens DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exec_tasks_system_read ON exec_tasks;
DROP POLICY IF EXISTS exec_tasks_user ON exec_tasks;
ALTER TABLE exec_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE exec_tasks DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exec_takeovers_system_read ON exec_takeovers;
DROP POLICY IF EXISTS exec_takeovers_user ON exec_takeovers;
ALTER TABLE exec_takeovers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE exec_takeovers DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS executors_system_read ON executors;
DROP POLICY IF EXISTS executors_user ON executors;
ALTER TABLE executors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE executors DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS confirm_challenges_system_read ON confirm_challenges;
DROP POLICY IF EXISTS confirm_challenges_user ON confirm_challenges;
ALTER TABLE confirm_challenges NO FORCE ROW LEVEL SECURITY;
ALTER TABLE confirm_challenges DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_sessions_system_read ON user_sessions;
DROP POLICY IF EXISTS user_sessions_user ON user_sessions;
ALTER TABLE user_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE user_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE client_tokens DROP CONSTRAINT IF EXISTS client_tokens_user_id_nonempty;
ALTER TABLE exec_tasks DROP CONSTRAINT IF EXISTS exec_tasks_user_id_nonempty;
ALTER TABLE exec_takeovers DROP CONSTRAINT IF EXISTS exec_takeovers_user_id_nonempty;
ALTER TABLE executors DROP CONSTRAINT IF EXISTS executors_user_id_nonempty;
ALTER TABLE confirm_challenges DROP CONSTRAINT IF EXISTS confirm_challenges_user_id_from_actor;
ALTER TABLE confirm_challenges DROP CONSTRAINT IF EXISTS confirm_challenges_user_id_nonempty;
ALTER TABLE confirm_challenges DROP COLUMN IF EXISTS user_id;
DROP FUNCTION IF EXISTS confirm_challenge_scope(text);
DELETE FROM core_schema_migrations WHERE version = '0036_rls_p0.sql';
COMMIT;
