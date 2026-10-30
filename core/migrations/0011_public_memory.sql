-- B6：公共记忆（HUB.md 第 5 节；D118）。用户明确允许共享的事实（偏好、背景、规矩），不是对话全文。
-- 按 user_id 隔离；每次修改留一个版本，可回滚。不放密钥（写入时拦截）。
CREATE TABLE public_memory (
  user_id    text        NOT NULL,
  topic      text        NOT NULL CHECK (topic ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  title      text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 128),
  body       text        NOT NULL CHECK (length(body) <= 20000),
  version    integer     NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, topic)
);

CREATE TABLE public_memory_versions (
  user_id    text        NOT NULL,
  topic      text        NOT NULL,
  version    integer     NOT NULL,
  title      text        NOT NULL,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, topic, version)
);
