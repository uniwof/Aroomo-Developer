-- 回退 0028。会删除聊天会话里的回复（role = 'assistant'）和聊天会话的 model / 群成员 / 归档信息：先 scripts/backup.sh。
-- FORCE 时迁移角色也受 RLS 约束，DELETE 会悄悄删 0 行（0023 B4）：临时取消 FORCE，删完再开
ALTER TABLE conversation_messages NO FORCE ROW LEVEL SECURITY;
DELETE FROM conversation_messages WHERE role = 'assistant';
ALTER TABLE conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages DROP COLUMN IF EXISTS meta;
ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_role_check;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_role_check CHECK (role IN ('user', 'member', 'system'));
DROP INDEX IF EXISTS conversations_chat_list_idx;
ALTER TABLE conversations DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS group_names, DROP COLUMN IF EXISTS model;
DELETE FROM core_schema_migrations WHERE version = '0028_saved_conversations.sql';
