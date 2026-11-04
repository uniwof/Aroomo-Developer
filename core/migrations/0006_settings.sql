-- Core 的简单设置（键值）。P0 只有负责人（lead），PRODUCT §8.3 设置「负责人」Tab、§9.3。
-- 不放任何密钥。
CREATE TABLE core_settings (
  key        text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL
);
