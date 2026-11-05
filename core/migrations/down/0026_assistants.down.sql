-- 回退 0026（先回退 0027）。会删除全部助手：先 scripts/backup.sh。
DROP TABLE IF EXISTS assistant_members;
DROP TABLE IF EXISTS assistants;
DELETE FROM core_schema_migrations WHERE version = '0026_assistants.sql';
