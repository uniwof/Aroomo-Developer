-- 回退 0027。会删除全部运行记录：先 scripts/backup.sh。
DROP TABLE IF EXISTS run_steps;
DROP TABLE IF EXISTS assistant_runs;
DELETE FROM core_schema_migrations WHERE version = '0027_assistant_runs.sql';
