-- Migration 001: Create append-only audit_logs table
-- PRODUCT §0.4, §3 第 7 条, §12 AuditLog
-- 说明：审计日志只追加、任何时候不得删除。
-- 本 SQL 脚本建立 audit_logs 表，并通过 PostgreSQL 触发器在数据库层硬性禁止 UPDATE 和 DELETE 操作。

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(128) PRIMARY KEY,
    ts BIGINT NOT NULL,
    actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN ('owner', 'operator', 'system', 'member')),
    actor_id VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    target_type VARCHAR(128) NOT NULL,
    target_id VARCHAR(128) NOT NULL,
    result VARCHAR(32) NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 索引：支持按时间戳、操作者、目标对象与动作高效查询
CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- 定义阻止 UPDATE 和 DELETE 的触发器函数
CREATE OR REPLACE FUNCTION prevent_audit_logs_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'AuditLog is append-only: UPDATE operations are strictly prohibited on audit_logs table.';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AuditLog is append-only: DELETE operations are strictly prohibited on audit_logs table.';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 绑定触发器到 audit_logs 表，禁止任何 UPDATE 与 DELETE 操作
DROP TRIGGER IF EXISTS trg_prevent_audit_logs_modification ON audit_logs;
CREATE TRIGGER trg_prevent_audit_logs_modification
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_logs_modification();

-- 数据库权限说明（在实际部署与数据库角色配置中配合使用）：
-- 在数据库层面，应用程序角色（如 app_user）应当仅获得 SELECT 与 INSERT 权限，
-- 明确剥夺 UPDATE 与 DELETE 权限，形成双重防线：
--   GRANT SELECT, INSERT ON TABLE audit_logs TO app_user;
--   REVOKE UPDATE, DELETE ON TABLE audit_logs FROM app_user;
