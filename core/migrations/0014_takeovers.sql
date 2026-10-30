-- 接管卡：执行员遇到验证码/人工步骤时请所有者处理。按 user_id 隔离。
CREATE TABLE exec_takeovers (
  id          uuid        PRIMARY KEY,
  user_id     text        NOT NULL,
  task_id     uuid        NOT NULL REFERENCES exec_tasks (id) ON DELETE CASCADE,
  reason      text        NOT NULL CHECK (length(reason) <= 200),
  message     text        NOT NULL CHECK (length(message) <= 1000),
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  note        text,
  created_at  timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX exec_takeovers_task_idx ON exec_takeovers (user_id, task_id, created_at);
