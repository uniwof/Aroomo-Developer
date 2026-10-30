-- 收件箱按账号隔离（D117）：user_id 为空 = 所有者的条目。
ALTER TABLE inbox_items ADD COLUMN user_id text;
DROP INDEX inbox_open_dedup_uq;
CREATE UNIQUE INDEX inbox_open_dedup_uq ON inbox_items (coalesce(user_id, ''), kind, related_type, related_id)
  WHERE status = 'open' AND related_type IS NOT NULL;
CREATE INDEX inbox_user_idx ON inbox_items (user_id) WHERE user_id IS NOT NULL;
