-- B1b-1：成员按用户隔离（D111、D117-18）。每张业务表加 user_id，所有查询都带它。
-- user_id 是文本：'owner' = 所有者令牌的数据（B1 之前的全部既有数据都属于它）；账号用户 = users.id（uuid 文本）。
-- 把所有者数据并入所有者自己的账号，是以后的显式管理员操作（待负责人确认），这里不自动合并。
ALTER TABLE members ADD COLUMN user_id text NOT NULL DEFAULT 'owner';
ALTER TABLE members DROP CONSTRAINT members_pkey;
ALTER TABLE members ADD PRIMARY KEY (user_id, id);

DROP INDEX members_name_active_uq;
DROP INDEX members_list_idx;
DROP INDEX members_deleted_idx;
CREATE UNIQUE INDEX members_name_active_uq ON members (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX members_list_idx ON members (user_id, pinned DESC, sort_order, created_at) WHERE deleted_at IS NULL;
CREATE INDEX members_deleted_idx ON members (user_id, deleted_at) WHERE deleted_at IS NOT NULL;
