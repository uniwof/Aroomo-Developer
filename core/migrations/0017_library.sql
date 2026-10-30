-- M2：资源库最小版（D163）。丢链接 / 记笔记，按关键词检索。按 user_id 隔离；同一用户同一个链接只留一条（去重）。
-- 检索先用 ILIKE（资源库规模小）；检索走 LibrarySearch 接口，以后可换 PGroonga / 向量检索而不改调用方。
CREATE TABLE library_items (
  id         text        PRIMARY KEY,
  user_id    text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('article','skill','method','material','tool','link','idea')),
  title      text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  url        text        CHECK (url IS NULL OR length(url) <= 2000),
  body       text        NOT NULL DEFAULT '' CHECK (length(body) <= 20000),
  tags       text        NOT NULL DEFAULT '' CHECK (length(tags) <= 500),
  source     text        NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX library_items_user_url ON library_items (user_id, url) WHERE url IS NOT NULL;
CREATE INDEX library_items_user_created ON library_items (user_id, created_at DESC);
