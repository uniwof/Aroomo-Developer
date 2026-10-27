-- Key 元数据存储表（PRODUCT §8.3、DECISIONS v4.3）
-- 注意：供应商 API Key 绝对禁止入库，只保存在 LiteLLM 中。
-- Core 本地数据库只保存非敏感元数据：名称、来源网址、末 4 位、LiteLLM 部署 id、状态。

CREATE TABLE IF NOT EXISTS keys (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  source_url TEXT NOT NULL,
  last4 VARCHAR(4) NOT NULL,
  litellm_deployment_id VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_keys_created_at ON keys(created_at DESC);
