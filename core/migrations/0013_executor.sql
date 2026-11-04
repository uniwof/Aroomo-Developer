-- 本机执行员（docs/executor-protocol.md）：设备登记 + 任务队列。全部按 user_id 隔离。
CREATE TABLE executors (
  id          uuid        PRIMARY KEY,
  user_id     text        NOT NULL,
  client_id   text        NOT NULL,
  device_name text        NOT NULL,
  platform    text        NOT NULL,
  version     text        NOT NULL,
  adapters    text[]      NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (user_id, client_id)
);
CREATE INDEX executors_user_idx ON executors (user_id);

CREATE TABLE exec_tasks (
  id               uuid        PRIMARY KEY,
  user_id          text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('checkin','login','signup','browse')),
  site             text        NOT NULL CHECK (length(site) <= 2048),
  instruction      text        NOT NULL DEFAULT '' CHECK (length(instruction) <= 4000),
  secrets          jsonb       NOT NULL DEFAULT '[]',
  options          jsonb       NOT NULL DEFAULT '{}',
  status           text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  executor_id      uuid,
  lease_expires_at timestamptz,
  cancel_requested boolean     NOT NULL DEFAULT false,
  last_stage       text,
  last_message     text,
  result_summary   text,
  result_error     text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX exec_tasks_user_idx ON exec_tasks (user_id, created_at);
CREATE INDEX exec_tasks_queue_idx ON exec_tasks (user_id, status, created_at);
