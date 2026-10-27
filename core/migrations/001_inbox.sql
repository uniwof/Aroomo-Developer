-- Migration 001: Inbox Items Table
-- Core/P0 收件箱数据表定义

CREATE TABLE IF NOT EXISTS inbox_items (
    id VARCHAR(128) PRIMARY KEY,
    "group" VARCHAR(32) NOT NULL, -- 'decision', 'candidate', 'brief'
    kind VARCHAR(64) NOT NULL,
    urgency VARCHAR(16) NOT NULL DEFAULT 'normal', -- 'urgent', 'normal', 'low'
    title VARCHAR(256) NOT NULL,
    summary TEXT NOT NULL,
    related_type VARCHAR(64),
    related_id VARCHAR(128),
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'open', -- 'open', 'done', 'dismissed', 'expired'
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ,
    resolved_action VARCHAR(64)
);

-- 索引：给侧栏未读计数和分组列表查询加速
CREATE INDEX IF NOT EXISTS idx_inbox_items_status_group_urgency_created
ON inbox_items (status, "group", urgency, created_at DESC);

-- 唯一条件索引：同一 related (type, id) 和 kind 的 open 条目去重
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_unique_open_related
ON inbox_items (kind, related_type, related_id)
WHERE status = 'open' AND related_type IS NOT NULL AND related_id IS NOT NULL;
