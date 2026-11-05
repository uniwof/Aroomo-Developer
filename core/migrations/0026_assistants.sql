-- 助手 v1（指南 v1.1 附录 C；docs/api/design-assistants-v1.md §1）：助手 + 成员组。RLS 键 user_id（待负责人定，附录 C 写 owner_account_id）。
-- 回退：migrations/down/0026_assistants.down.sql
CREATE TABLE assistants (
  id                uuid        PRIMARY KEY,
  user_id           text        NOT NULL CONSTRAINT assistants_user_id_nonempty CHECK (user_id <> ''),
  name              text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  instructions      text        NOT NULL CHECK (length(btrim(instructions)) BETWEEN 10 AND 4000),
  lead_member_id    text,
  enabled           boolean     NOT NULL DEFAULT true,
  schedule_kind     text        NOT NULL DEFAULT 'manual' CHECK (schedule_kind IN ('manual', 'daily', 'weekly', 'interval')),
  schedule_spec     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  timezone          text        NOT NULL,
  catch_up          text        NOT NULL DEFAULT 'skip' CHECK (catch_up IN ('skip', 'latest')),
  max_runtime_sec   integer     NOT NULL DEFAULT 600 CHECK (max_runtime_sec BETWEEN 60 AND 1800),
  budget_level      text        NOT NULL DEFAULT 'low' CHECK (budget_level IN ('low', 'mid', 'high')),
  notify            boolean     NOT NULL DEFAULT true,
  conversation_id   uuid        NOT NULL,
  next_run_at       timestamptz,
  paused_at         timestamptz,
  idempotency_key   text        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  idempotency_hash  text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  UNIQUE (id, user_id),
  CHECK ((schedule_kind = 'manual') OR next_run_at IS NOT NULL OR NOT enabled OR paused_at IS NOT NULL),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id),
  -- 组长被彻底删除（回收站到期）时只清空组长，助手保留；运行时报 no_member
  FOREIGN KEY (user_id, lead_member_id) REFERENCES members (user_id, id) ON DELETE SET NULL (lead_member_id)
);
CREATE UNIQUE INDEX assistants_idem_uq ON assistants (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX assistants_user_idx ON assistants (user_id, created_at);
-- 执行器第一步（systemScoped 只读）找到期助手用
CREATE INDEX assistants_due_idx ON assistants (next_run_at) WHERE enabled AND paused_at IS NULL AND next_run_at IS NOT NULL;

CREATE TABLE assistant_members (
  assistant_id uuid    NOT NULL,
  user_id      text    NOT NULL CONSTRAINT assistant_members_user_id_nonempty CHECK (user_id <> ''),
  member_id    text    NOT NULL,
  role         text    NOT NULL CHECK (role IN ('lead', 'worker')),
  position     integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (assistant_id, member_id),
  FOREIGN KEY (assistant_id, user_id) REFERENCES assistants (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, member_id) REFERENCES members (user_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX assistant_members_one_lead ON assistant_members (assistant_id) WHERE role = 'lead';

ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants FORCE ROW LEVEL SECURITY;
CREATE POLICY assistants_user ON assistants
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY assistants_system_read ON assistants FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE assistant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_members FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_members_user ON assistant_members
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY assistant_members_system_read ON assistant_members FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
