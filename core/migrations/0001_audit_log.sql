-- 审计日志：只追加（PRODUCT §0.4、§12 AuditLog；DECISIONS D50）。
-- 应用层接口没有修改/删除方法；数据库层再用触发器拒绝 UPDATE / DELETE / TRUNCATE，
-- 即使有人拿到数据库连接、绕过 Core 直接写 SQL，也删改不了已有记录。
-- 说明：表属主或超级用户仍可 ALTER TABLE ... DISABLE TRIGGER；这类操作只能在维护窗口由用户授权执行，
-- 并须先备份。P1 拆分「迁移角色 / 运行角色」后，运行角色只授予 INSERT、SELECT（见 PR 说明）。

CREATE TABLE audit_log (
  seq         bigserial   PRIMARY KEY,
  id          uuid        NOT NULL UNIQUE,
  ts          timestamptz NOT NULL,
  actor_type  text        NOT NULL CHECK (actor_type IN ('owner', 'operator', 'system', 'member')),
  actor_id    text        NOT NULL,
  action      text        NOT NULL,
  target_type text        NOT NULL,
  target_id   text        NOT NULL,
  result      text        NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
  note        text
);

CREATE INDEX audit_log_ts_idx     ON audit_log (ts);
CREATE INDEX audit_log_action_idx ON audit_log (action, seq);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, seq);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_type, actor_id, seq);

CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;
