-- X-06 分工的送达状态：run_steps.status 多一种 received（已收到 = 成员的模型接下了这件事，还没开始回字）。
-- 成员那一步依次是 pending（已派出）→ received（已收到）→ running（在做）→ done（已回复）。只放宽一个 CHECK，不改已有数据。
-- 回退：migrations/down/0029_run_step_received.down.sql
ALTER TABLE run_steps DROP CONSTRAINT run_steps_status_check;
ALTER TABLE run_steps ADD CONSTRAINT run_steps_status_check
  CHECK (status IN ('pending', 'received', 'running', 'done', 'failed', 'skipped', 'waiting_confirmation'));
