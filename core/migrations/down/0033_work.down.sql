-- 回退 0033。会删除全部 /work 项目和同步来的版本快照（来源还在 GitHub 上，重新建项目、同步即可拿回），不影响其他数据。
DROP TABLE IF EXISTS work_versions;
DROP FUNCTION IF EXISTS work_versions_immutable();
DROP TABLE IF EXISTS work_projects;
DELETE FROM core_schema_migrations WHERE version = '0033_work.sql';
