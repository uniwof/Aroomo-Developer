-- /work 切片 2（docs/api/design-work-v1.md）：公共记忆的每个版本、助手的每次成功运行也是版本来源。回退：migrations/down/0034_work_sources.down.sql
-- 不加表、不改 RLS（work_versions 的 ENABLE + FORCE RLS、只追加、不可变触发器都照旧）。
ALTER TABLE work_versions DROP CONSTRAINT work_versions_source_type_check;
ALTER TABLE work_versions ADD CONSTRAINT work_versions_source_type_check
  CHECK (source_type IN ('github_release', 'github_tag', 'memory', 'assistant_run'));
-- 排序（负责人 #323 小事）：不再用 coalesce(source_at, synced_at)，那样会拿 tag 的同步时间去和别的版本的来源时间比。
-- 改成：有来源时间的按来源时间（新在前），没有时间的（tag）排在后面，按写入先后 seq（= GitHub 给的先后）。
DROP INDEX work_versions_timeline_idx;
CREATE INDEX work_versions_timeline_idx ON work_versions (user_id, project_id, source_at DESC NULLS LAST, seq DESC);
