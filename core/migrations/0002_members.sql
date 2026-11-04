-- 成员（PRODUCT §9.1、§12 Member、§8.4 列表操作：删除进回收站 30 天、排序、置顶）。
CREATE TABLE members (
  id              text        PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,64}$'),
  name            text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  aliases         text[]      NOT NULL DEFAULT '{}',
  capability_tags text[]      NOT NULL DEFAULT '{}'
                  CHECK (capability_tags <@ ARRAY['text','long-context','image','video','multimodal','voice','code','reasoning']::text[]),
  enabled         boolean     NOT NULL DEFAULT true,
  pinned          boolean     NOT NULL DEFAULT false,
  sort_order      integer     NOT NULL DEFAULT 0,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- 名字大小写不敏感去重，只在未删除成员之间（回收站里的同名成员撤销删除时再检查）
CREATE UNIQUE INDEX members_name_active_uq ON members (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX members_list_idx ON members (pinned DESC, sort_order, created_at) WHERE deleted_at IS NULL;
CREATE INDEX members_deleted_idx ON members (deleted_at) WHERE deleted_at IS NOT NULL;
