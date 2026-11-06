-- 回退 0032_inbox_decision.sql：删掉发起者、影响范围、处理理由三列（数据随之丢弃）。
ALTER TABLE inbox_items DROP COLUMN IF EXISTS actor, DROP COLUMN IF EXISTS impact, DROP COLUMN IF EXISTS resolved_note;
DELETE FROM core_schema_migrations WHERE version = '0032_inbox_decision.sql';
