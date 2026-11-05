-- 助手 v1（docs/api/design-assistants-v1.md §1）：会话底座。本阶段只有助手的固定会话写这里；会话存库沿用同一张表（待负责人定）。
-- RLS 模板同 0019–0024；复合外键 (conversation_id, user_id) 让消息挂不到别人的会话上。回退：migrations/down/0025_conversations.down.sql
CREATE TABLE conversations (
  id          uuid        PRIMARY KEY,
  user_id     text        NOT NULL CONSTRAINT conversations_user_id_nonempty CHECK (user_id <> ''),
  kind        text        NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'assistant')),
  title       text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  member_ids  text[]      NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  UNIQUE (id, user_id)
);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC) WHERE deleted_at IS NULL;

-- X-21：消息只追加。编辑 / 重试都是新增一行；删除只随会话整体删除（ON DELETE CASCADE）。
CREATE TABLE conversation_messages (
  id              uuid        PRIMARY KEY,
  -- 会话内顺序与分页游标（同一毫秒写入的消息也有确定顺序）
  seq             bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  conversation_id uuid        NOT NULL,
  user_id         text        NOT NULL CONSTRAINT conversation_messages_user_id_nonempty CHECK (user_id <> ''),
  role            text        NOT NULL CHECK (role IN ('user', 'member', 'system')),
  member_id       text        CHECK (member_id IS NULL OR member_id ~ '^[a-z0-9-]{1,64}$'),
  run_id          uuid,
  content         text        NOT NULL CHECK (length(content) BETWEEN 1 AND 50000),
  created_at      timestamptz NOT NULL,
  CHECK ((role = 'member') = (member_id IS NOT NULL)),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) ON DELETE CASCADE
);
CREATE INDEX conversation_messages_conv_idx ON conversation_messages (conversation_id, seq);

CREATE FUNCTION aroomo_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 只追加，不能修改', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER conversation_messages_append_only BEFORE UPDATE ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION aroomo_append_only();

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_user ON conversations
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY conversations_system_read ON conversations FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_messages_user ON conversation_messages
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY conversation_messages_system_read ON conversation_messages FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
