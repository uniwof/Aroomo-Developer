-- B3 底座：外部客户端令牌（docs/architecture/HUB.md 第 1.1 节；D118「每客户端独立令牌、最小权限、可一键吊销、全量审计」）。
-- 令牌只存 SHA-256；scopes 是白名单，默认空；user_id 沿用 B1b 的归属键（'owner' 或 users.id）。
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('owner', 'operator', 'system', 'member', 'user', 'client'));

CREATE TABLE client_tokens (
  id                 uuid        PRIMARY KEY,
  user_id            text        NOT NULL,
  name               text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  token_hash         text        NOT NULL UNIQUE,
  scopes             text[]      NOT NULL DEFAULT '{}',
  rate_limit_per_min integer     NOT NULL DEFAULT 60 CHECK (rate_limit_per_min BETWEEN 1 AND 6000),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz,
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
CREATE INDEX client_tokens_user_idx ON client_tokens (user_id, created_at);
