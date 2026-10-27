-- PostgreSQL Migration for Members table
-- PRODUCT §12 Member

CREATE TABLE IF NOT EXISTS members (
    id VARCHAR(128) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    capability_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT true,
    pinned BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL DEFAULT 0,
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique index on lower(name) for case-insensitive name uniqueness checks
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_lower_name ON members (LOWER(name));

-- Indexes for listing and filtering
CREATE INDEX IF NOT EXISTS idx_members_deleted_at ON members (deleted_at);
CREATE INDEX IF NOT EXISTS idx_members_pinned_sort ON members (pinned DESC, sort_order ASC);
