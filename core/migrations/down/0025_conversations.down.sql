-- 回退 0025（先回退 0028、0027、0026；0028 改过这两张表，不先回退它会在 core_schema_migrations 留下 0028 的记录）。会删除会话和消息：先 scripts/backup.sh。
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS conversations;
DROP FUNCTION IF EXISTS aroomo_append_only();
DELETE FROM core_schema_migrations WHERE version = '0025_conversations.sql';
