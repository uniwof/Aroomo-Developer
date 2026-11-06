-- /work 项目与版本 v1 切片 1（docs/api/design-work-v1.md；Poke 清单 10 + 1 的 /work）。回退：migrations/down/0033_work.down.sql
-- 只用真实信号：项目是所有者自己建的；版本只由来源同步产生（切片 1 只有 GitHub 公开仓库的已发布 / 预发布 release 和 tag）。
-- 两张表都按 user_id 隔离（ENABLE + FORCE RLS，模板同 0029）。版本是不可变快照：触发器拒绝 UPDATE，应用角色不能 DELETE（app-role.ts APPEND_ONLY_TABLES）。
CREATE TABLE work_projects (
  id           uuid        PRIMARY KEY,
  user_id      text        NOT NULL CONSTRAINT work_projects_user_id_nonempty CHECK (user_id <> ''),
  name         text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  -- [{ "type": "github", "repo": "owner/name" }]，最多 5 个（服务层校验格式）
  sources      jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 5),
  last_sync_at timestamptz,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  deleted_at   timestamptz,
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX work_projects_name_uq ON work_projects (user_id, lower(name)) WHERE deleted_at IS NULL;
ALTER TABLE work_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY work_projects_user ON work_projects
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY work_projects_system_read ON work_projects FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');

CREATE TABLE work_versions (
  id           uuid        PRIMARY KEY,
  user_id      text        NOT NULL CONSTRAINT work_versions_user_id_nonempty CHECK (user_id <> ''),
  project_id   uuid        NOT NULL,
  -- 切片 3 再加 memory / assistant_run（ALTER 这个 CHECK）
  source_type  text        NOT NULL CHECK (source_type IN ('github_release', 'github_tag')),
  source_ref   text        NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 300),
  label        text        NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  title        text        CHECK (title IS NULL OR length(title) <= 300),
  -- 产出者：{ "type": "github", "name": "<login>" }；拿不到（tag）就是 NULL，不编
  actor        jsonb       CHECK (actor IS NULL OR (jsonb_typeof(actor) = 'object' AND length(actor::text) <= 500)),
  -- [{ "type": "page"|"file", "title": "...", "url": "https://github.com/..."|null, "size": 123|null }]，链接同步时已过滤主机
  artifacts    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(artifacts) = 'array' AND jsonb_array_length(artifacts) <= 21 AND length(artifacts::text) <= 20000),
  -- 来源状态：published / prerelease（GitHub release）、tagged（只有 tag），none 留给切片 3 的公共记忆、助手
  source_state text        NOT NULL CHECK (source_state IN ('published', 'prerelease', 'tagged', 'none')),
  -- 来源给的时间（release 的 published_at）；tag 没有时间 = NULL，不拿提交时间冒充
  source_at    timestamptz,
  synced_at    timestamptz NOT NULL,
  -- 写入先后（负责人 #323 必改 1）：同一次同步按 GitHub 给的先后倒着插，最新的号最大；时间相同（tag 没有时间）时按它排，不按随机 uuid
  seq          bigint      GENERATED ALWAYS AS IDENTITY,
  UNIQUE (project_id, source_type, source_ref),
  FOREIGN KEY (project_id, user_id) REFERENCES work_projects (id, user_id)
);
CREATE INDEX work_versions_timeline_idx ON work_versions (user_id, project_id, (coalesce(source_at, synced_at)) DESC, seq DESC);
-- 不可变快照：内容写入后不能改（来源后来改了也不覆盖，下一次同步只加新版本）。
-- 唯一例外（负责人 #323 必改 2）：GitHub 把预发布转成正式发布时，source_state 只许 prerelease → published，别的列一个都不能动，也不能往回改
CREATE FUNCTION work_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_state = 'prerelease' AND NEW.source_state = 'published'
     AND (NEW.id, NEW.user_id, NEW.project_id, NEW.source_type, NEW.source_ref, NEW.label, NEW.title, NEW.actor, NEW.artifacts, NEW.source_at, NEW.synced_at, NEW.seq)
         IS NOT DISTINCT FROM (OLD.id, OLD.user_id, OLD.project_id, OLD.source_type, OLD.source_ref, OLD.label, OLD.title, OLD.actor, OLD.artifacts, OLD.source_at, OLD.synced_at, OLD.seq) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'work_versions 是不可变快照，不能修改';
END $$;
CREATE TRIGGER work_versions_no_update BEFORE UPDATE ON work_versions FOR EACH ROW EXECUTE FUNCTION work_versions_immutable();
ALTER TABLE work_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY work_versions_user ON work_versions
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY work_versions_system_read ON work_versions FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
