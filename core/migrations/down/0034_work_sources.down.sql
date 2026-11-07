-- 回退 0034：删掉公共记忆、助手两类版本快照（来源还在，升级回来再同步即可拿回），来源类型和排序索引退回 0033。
DELETE FROM work_versions WHERE source_type IN ('memory', 'assistant_run');
ALTER TABLE work_versions DROP CONSTRAINT work_versions_source_type_check;
ALTER TABLE work_versions ADD CONSTRAINT work_versions_source_type_check CHECK (source_type IN ('github_release', 'github_tag'));
DROP INDEX IF EXISTS work_versions_timeline_idx;
CREATE INDEX work_versions_timeline_idx ON work_versions (user_id, project_id, (coalesce(source_at, synced_at)) DESC, seq DESC);
DELETE FROM core_schema_migrations WHERE version = '0034_work_sources.sql';
