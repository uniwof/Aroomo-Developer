-- 统一确认服务（DECISIONS D63，取代 0003 的一次性确认令牌 confirm_tokens）。
-- 一条 challenge = 一次「需要确认的操作」。普通确认不落库；重要确认（不可逆、花钱、涉及凭据）：
--   第一次点击 → step1_at；≥3 秒后第二次点击（凭据操作还要新的 Cloudflare Access 令牌）→ 签发一次性令牌（只存 SHA-256）
--   → 带令牌重新调用原接口 → used_at。令牌绑定 scope、操作者，以及请求体的加盐摘要（payload_digest）。
DROP TABLE IF EXISTS confirm_tokens;

CREATE TABLE confirm_challenges (
  id               uuid        PRIMARY KEY,
  scope            text        NOT NULL,
  actor            text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('irreversible', 'payment', 'credential')),
  title            text        NOT NULL,
  consequences     jsonb       NOT NULL,
  confirm_label    text        NOT NULL,
  payload_salt     text,
  payload_digest   text,
  requires_reauth  boolean     NOT NULL,
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  step1_at         timestamptz,
  token_hash       text        UNIQUE,
  token_issued_at  timestamptz,
  used_at          timestamptz,
  CHECK ((payload_salt IS NULL) = (payload_digest IS NULL))
);
CREATE INDEX confirm_challenges_expires_idx ON confirm_challenges (expires_at);
