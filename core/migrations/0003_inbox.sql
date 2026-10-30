-- 收件箱（PRODUCT §2.2、§9.9、§12 InboxItem）与不可逆操作的二次确认令牌（DECISIONS D50）。
CREATE TABLE inbox_items (
  id              uuid        PRIMARY KEY,
  grp             text        NOT NULL CHECK (grp IN ('decision', 'candidate', 'brief')),
  kind            text        NOT NULL,
  urgency         text        NOT NULL CHECK (urgency IN ('urgent', 'normal', 'low')),
  title           text        NOT NULL,
  summary         text        NOT NULL DEFAULT '',
  related_type    text,
  related_id      text,
  actions         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status          text        NOT NULL CHECK (status IN ('open', 'done', 'dismissed', 'expired')),
  created_at      timestamptz NOT NULL,
  resolved_at     timestamptz,
  resolved_action text,
  CHECK ((related_type IS NULL) = (related_id IS NULL))
);

-- 同一 related + kind 只能有一条 open（去重）
CREATE UNIQUE INDEX inbox_open_dedup_uq ON inbox_items (kind, related_type, related_id)
  WHERE status = 'open' AND related_type IS NOT NULL;
CREATE INDEX inbox_list_idx ON inbox_items (grp, status, created_at DESC);

-- 二次确认令牌：只存 SHA-256；绑定 scope（如 inbox:<id>:<action>）与操作者；一次性、5 分钟有效
CREATE TABLE confirm_tokens (
  token_hash text        PRIMARY KEY,
  scope      text        NOT NULL,
  actor      text        NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX confirm_tokens_expires_idx ON confirm_tokens (expires_at);
