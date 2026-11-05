-- 回退 0025（先回退 0027、0026）。会删除会话和消息：先 scripts/backup.sh。
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS conversations;
DROP FUNCTION IF EXISTS aroomo_append_only();
DELETE FROM core_schema_migrations WHERE version = '0025_conversations.sql';
