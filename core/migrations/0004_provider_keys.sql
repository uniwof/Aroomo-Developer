-- Key 管理的本地元数据（Issue #6；DECISIONS D34、D45；docs/architecture/KEY-STORAGE.md）。
-- 这张表**故意没有任何存放 Key 的列**：完整 Key 只存在 LiteLLM 数据库（由 LITELLM_SALT_KEY 加密）。
-- 这里只有名称、获取网址、末 4 位、LiteLLM 部署 id 和状态。
CREATE TABLE provider_keys (
  id               uuid        PRIMARY KEY,
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  source_url       text        NOT NULL,
  last4            text        NOT NULL CHECK (length(last4) = 4),
  model            text        NOT NULL,
  model_name       text        NOT NULL,
  api_base         text,
  litellm_model_id text        NOT NULL UNIQUE,
  status           text        NOT NULL CHECK (status IN ('active', 'sync_failed')),
  models_synced_at timestamptz,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
