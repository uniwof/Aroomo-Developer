-- 会话存库（#250 integrate/stage2；checklist F-036 / X-21 / X-27 / X-04b）：沿用 0025 的 conversations / conversation_messages（RLS 不变）。
-- 只加列、放宽一个 CHECK，不改已有数据。回退：migrations/down/0028_saved_conversations.down.sql
-- conversations：聊天会话（kind = 'chat'）要记住交给谁（model）、群里挑了哪几位（group_names，前端按名字存）、是否归档（不删除）。
ALTER TABLE conversations
  ADD COLUMN model       text   NOT NULL DEFAULT 'aroomo' CHECK (model ~ '^aroomo(/[^\s]{1,100})?$'),
  ADD COLUMN group_names text[] NOT NULL DEFAULT '{}' CHECK (cardinality(group_names) <= 20),
  ADD COLUMN archived_at timestamptz;
CREATE INDEX conversations_chat_list_idx ON conversations (user_id, archived_at, updated_at DESC, id DESC) WHERE kind = 'chat' AND deleted_at IS NULL;

-- conversation_messages：聊天里的回复是 role = 'assistant'（谁回答的写在正文末尾的署名里，同 /v1）；
-- meta 只放 Core 生成的结构化部件（目前只有 X-15 助手草稿卡 { draft: { id, data } }）和「从本机导入」标记。仍然只追加（0025 的触发器）。
ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_role_check;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_role_check CHECK (role IN ('user', 'member', 'system', 'assistant'));
ALTER TABLE conversation_messages ADD COLUMN meta jsonb CHECK (meta IS NULL OR (jsonb_typeof(meta) = 'object' AND length(meta::text) <= 20000));
