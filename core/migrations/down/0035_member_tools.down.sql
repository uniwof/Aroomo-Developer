-- 回退 0035。会删除全部成员工具分配（只是引用，工具本身和成员都不受影响；重新分配即可），不影响其他数据。
DROP TABLE IF EXISTS member_tools;
DELETE FROM core_schema_migrations WHERE version = '0035_member_tools.sql';
