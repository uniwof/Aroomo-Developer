-- B2：保险箱（HUB.md 第 2 节；D118）。工具类密钥的信封加密存放：
-- 每条记录一把随机数据密钥（DEK，AES-256-GCM），DEK 由 VAULT_KEY 加密后随记录存放；aad = user_id || secret_id。
-- 模型服务商 Key 不放这里（只在 LiteLLM，D34/D45）。删除 = 清空密文并记 deleted_at（无法恢复）。
CREATE TABLE vault_secrets (
  id          text        PRIMARY KEY,
  user_id     text        NOT NULL,
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  kind        text        NOT NULL CHECK (kind IN ('api_key','token','password','note')),
  last4       text        NOT NULL DEFAULT '',
  ciphertext  text        NOT NULL,
  dek_wrapped text        NOT NULL,
  nonce       text        NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  rotated_at  timestamptz,
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX vault_secrets_user_name ON vault_secrets (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX vault_secrets_user ON vault_secrets (user_id) WHERE deleted_at IS NULL;
