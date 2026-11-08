-- 回退 0034：删掉公共记忆、助手两类版本快照（0033 的 CHECK 不收它们，只能删），来源类型和排序索引退回 0033。
-- 升级回来再同步能拿回来源里还在的；公共记忆已被清理的旧版本（超过 50 版）和已删助手的运行拿不回来——回退前先做部署前备份（RELEASE.md）。
--
-- 执行身份（负责人 #342 必改 1）：生产迁移身份 aroomo_core —— 能登录、是表所有者、不是超级用户、没有 BYPASSRLS
-- （deploy/postgres/20-aroomo-dbs.sh、docs/ops/RLS.md）。用 psql -U aroomo_core -d aroomo_core -f 本文件 跑，不要用应用角色 aroomo_core_app。
--
-- 依赖 0033 对 work_versions 建的策略与触发器（migrations/0033_work.sql 原文）：
--   ALTER TABLE work_versions ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE work_versions FORCE ROW LEVEL SECURITY;
--   CREATE POLICY work_versions_user ON work_versions
--     USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
--     WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
--   CREATE POLICY work_versions_system_read ON work_versions FOR SELECT
--     USING (current_setting('app.system_scope', true) = 'on');
--   CREATE TRIGGER work_versions_no_update BEFORE UPDATE ON work_versions FOR EACH ROW EXECUTE FUNCTION work_versions_immutable();
-- 所以：FORCE 下表所有者也受策略约束；迁移会话没有 app.user_id，work_versions_user 一行都不放，
-- 直接 DELETE 会「成功删 0 行」，接着加回只收 GitHub 的 CHECK 时被残留的 memory / assistant_run 行撞失败。
-- 做法：在同一个事务里临时 NO FORCE（表所有者于是不受策略约束），删完立刻 FORCE 回去；失败整体回滚，FORCE 不会被留在关着的状态；
-- 真有没删掉的行，下面加 CHECK 时校验会扫全表（不受 RLS）大声失败、整体回滚，不会半退。
-- 不可变触发器只拦 UPDATE（BEFORE UPDATE），不拦 DELETE，这里不用碰它；删除权限只从应用角色收回（app-role.ts APPEND_ONLY_TABLES），所有者照常能删。
BEGIN;
ALTER TABLE work_versions NO FORCE ROW LEVEL SECURITY;
DELETE FROM work_versions WHERE source_type IN ('memory', 'assistant_run');
ALTER TABLE work_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE work_versions DROP CONSTRAINT work_versions_source_type_check;
ALTER TABLE work_versions ADD CONSTRAINT work_versions_source_type_check CHECK (source_type IN ('github_release', 'github_tag'));
DROP INDEX IF EXISTS work_versions_timeline_idx;
CREATE INDEX work_versions_timeline_idx ON work_versions (user_id, project_id, (coalesce(source_at, synced_at)) DESC, seq DESC);
DELETE FROM core_schema_migrations WHERE version = '0034_work_sources.sql';
COMMIT;
