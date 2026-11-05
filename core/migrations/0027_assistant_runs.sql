-- 助手 v1：运行记录 + 步骤事件（附录 C、X-03、X-13、X-21）。回退：migrations/down/0027_assistant_runs.down.sql
CREATE TABLE assistant_runs (
  id               uuid        PRIMARY KEY,
  assistant_id     uuid        NOT NULL,
  user_id          text        NOT NULL CONSTRAINT assistant_runs_user_id_nonempty CHECK (user_id <> ''),
  trigger          text        NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  scheduled_for    timestamptz,
  idempotency_key  text        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  requested_at     timestamptz NOT NULL,
  started_at       timestamptz,
  finished_at      timestamptz,
  status           text        NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'waiting_confirmation', 'cancelled')),
  -- 对话的 4 种 + timeout、budget（附录 C）+ server_restart（X-21）、no_member（待负责人确认）
  failure_code     text        CHECK (failure_code IS NULL OR failure_code IN
                     ('gateway_unreachable', 'key_invalid', 'rate_limited', 'upstream_error', 'timeout', 'budget', 'server_restart', 'no_member')),
  summary          text        CHECK (summary IS NULL OR length(summary) <= 20000),
  usage_state      text        CHECK (usage_state IS NULL OR usage_state IN ('ample', 'tight', 'exhausted')),
  calls            integer     NOT NULL DEFAULT 0 CHECK (calls >= 0),
  message_ids      uuid[]      NOT NULL DEFAULT '{}',
  UNIQUE (id, user_id),
  CHECK ((trigger = 'schedule') = (scheduled_for IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  FOREIGN KEY (assistant_id, user_id) REFERENCES assistants (id, user_id) ON DELETE CASCADE
);
-- 定时触发的幂等键：同一助手同一计划时刻只占一次
CREATE UNIQUE INDEX assistant_runs_sched_uq ON assistant_runs (assistant_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE UNIQUE INDEX assistant_runs_idem_uq ON assistant_runs (assistant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- 同一助手同时只跑一次（库层兜底）
CREATE UNIQUE INDEX assistant_runs_one_active ON assistant_runs (assistant_id) WHERE status IN ('queued', 'running');
-- 同一助手最多一张「等确认」（负责人裁定 12）：上一次还在等，定时 / 立即运行都跳过；超过 24 小时自动作废
CREATE UNIQUE INDEX assistant_runs_one_waiting ON assistant_runs (assistant_id) WHERE status = 'waiting_confirmation';
CREATE INDEX assistant_runs_list_idx ON assistant_runs (assistant_id, requested_at DESC, id);
CREATE INDEX assistant_runs_active_idx ON assistant_runs (status) WHERE status IN ('queued', 'running');

-- 步骤事件：只追加；每变一次状态插一行，当前状态 = 每个 step_no 的最后一行
CREATE TABLE run_steps (
  run_id     uuid        NOT NULL,
  user_id    text        NOT NULL CONSTRAINT run_steps_user_id_nonempty CHECK (user_id <> ''),
  seq        integer     NOT NULL CHECK (seq >= 0),
  step_no    integer     NOT NULL CHECK (step_no >= 0),
  member_id  text,
  action     text        NOT NULL CHECK (action IN ('plan', 'work', 'summarize', 'confirm')),
  status     text        NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped', 'waiting_confirmation')),
  detail     text        NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id, user_id) REFERENCES assistant_runs (id, user_id) ON DELETE CASCADE
);
CREATE TRIGGER run_steps_append_only BEFORE UPDATE ON run_steps
  FOR EACH ROW EXECUTE FUNCTION aroomo_append_only();

ALTER TABLE assistant_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_runs_user ON assistant_runs
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY assistant_runs_system_read ON assistant_runs FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY run_steps_user ON run_steps
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY run_steps_system_read ON run_steps FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
