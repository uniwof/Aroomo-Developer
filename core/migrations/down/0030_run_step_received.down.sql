-- 回退 0030。会删掉步骤里「已收到」的事件行（同一步后面的 running / done 还在，任务卡照样能显示当前状态）：先 scripts/backup.sh。
-- FORCE 时迁移角色也受 RLS 约束，DELETE 会悄悄删 0 行（0023 B4）：临时取消 FORCE，删完再开
ALTER TABLE run_steps NO FORCE ROW LEVEL SECURITY;
DELETE FROM run_steps WHERE status = 'received';
ALTER TABLE run_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE run_steps DROP CONSTRAINT run_steps_status_check;
ALTER TABLE run_steps ADD CONSTRAINT run_steps_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped', 'waiting_confirmation'));
DELETE FROM core_schema_migrations WHERE version = '0030_run_step_received.sql';
