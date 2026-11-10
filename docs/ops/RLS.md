# 行级安全（RLS）运维与迁移规矩（D206）

## 策略模板（0019 起统一）
每张业务表：ENABLE + FORCE；CHECK (user_id <> '')；隔离策略 `user_id = NULLIF(current_setting('app.user_id', true), '')`（USING + WITH CHECK）；系统范围（app.system_scope=on）只有只读 SELECT 策略，不能写。

## 迁移里改业务表数据的规矩
FORCE 之后表所有者（迁移角色）也受 RLS 约束：迁移里写 `UPDATE members ...` 会悄悄改到 0 行且不报错。
- 数据回填放在 ENABLE/FORCE 之前；或
- 同一个迁移文件里先 `ALTER TABLE t NO FORCE ROW LEVEL SECURITY`，改完再 `FORCE`。

migrate() 把整次迁移（所有未执行的文件）放在同一个事务里，并持 advisory lock；任一文件失败则整体回滚，所以每个文件至少在一个事务内执行。

## systemScoped
只给跨用户系统任务，只读。新增调用处必须进 core/test/system-scoped-allowlist.test.ts 的白名单，并在 PR 说明理由（负责人审）。

## 登录前查找与跨用户清理（0036，#345 P0）
client_tokens、user_sessions 按令牌哈希查找发生在知道「是谁」之前：只读这一步用 systemScoped（`getByHash` / `getSession`），查到之后的 touch、吊销、新建都切回 userScoped。
exec_tasks 的 `sweep`、confirm_challenges 的 `deleteExpired` 是定时的跨用户清理：先 systemScoped 只读找出受影响的 user_id，再逐个 user_id 在 userScoped 里改 / 删（系统范围没有写策略；userScoped 里的 UPDATE / DELETE 也带显式 `user_id = $N`）。
系统范围看得见 `user_id = ''` 的旧脏行（非空串 CHECK 是 NOT VALID），所以系统范围的查询一律带 `user_id <> ''`，不然 `userScoped('')` 抛错，一行脏数据会让所有用户的清扫失败。
confirm_challenges 原来没有 user_id，0036 加列并按 actor 换算：`owner`→`owner`，`user:<id>`→`<id>`，其他原样。规则只写在 SQL 函数 `confirm_challenge_scope(actor)` 里，回填和 CHECK `user_id = confirm_challenge_scope(actor)` 都用它；应用侧 `challengeScope(actor)` 必须一致（不一致的写入被数据库拒，有等价性测试）。消费确认卡时应用层仍校验 `r.actor === ctx.actor`（双保险）。
user_sessions.user_id 是 uuid，策略写 `user_id::text = …`。其余四张 text 表的非空串 CHECK 用 NOT VALID，已进 `scripts/lib/rls-tables.txt`，发布前预检查空串；上生产前清理（#229）并补 VALIDATE CONSTRAINT 迁移。
回退：`core/migrations/down/0036_rls_p0.down.sql`（回退前先备份；表所有者执行；先删约束再删列，最后删函数）。仍无 RLS 的表见 `core/test/authz/cross-account.test.ts` 的 NO_RLS_TABLES。

## 应用连接角色与上线步骤

- 规则：业务表 `user_id = current_setting('app.user_id')`，ENABLE + FORCE。Core 每个事务开头 `set_config('app.user_id', …, true)`（`core/src/db/scope.ts`）。
- 角色：`aroomo_core`（能登录、表所有者）只跑迁移和授权；业务连接用应用角色 `aroomo_core_app`（非所有者、非超级用户、无 BYPASSRLS、不建库不建角色）。Core 每次启动由所有者给它授权（只有 SELECT/INSERT/UPDATE/DELETE，只追加的表见下），再在应用连接上自检，不满足就拒绝启动（`core/src/db/app-role.ts`）。

### 两种接法（D213 第 13 项）
| | 旧做法（SET ROLE） | 独立登录（阶段 3 生产必须） |
|---|---|---|
| `.env` | `CORE_DB_APP_ROLE=aroomo_core_app` | 再加 `CORE_APP_DB_PASSWORD=…`（脚本写） |
| 业务连接的登录身份 | `aroomo_core`（所有者），握手时切到应用角色 | `aroomo_core_app` 自己 |
| 注入后能不能关掉 RLS | **能**：会话里一句 `SET ROLE aroomo_core` 回到所有者，再 `ALTER TABLE … NO FORCE` | 不能：`SET ROLE`/`RESET ROLE` 都回不到所有者，`ALTER TABLE`、`DROP POLICY`、`TRUNCATE`、`row_security=off` 全部失败 |
| 自检 | 角色名对、非所有者、非超级用户、FORCE 齐 | 另外要求登录身份就是应用角色、且变不成任何表所有者 |

测试：`core/test/db-app-role-login.test.ts`（真 PostgreSQL，CI 必跑）；旧做法能被一句 `SET ROLE` 关掉 FORCE 也在里面作为对照。

### 改成独立登录（staging 先做，生产在第二个用户进来前做；每个环境一次，可重复跑）
0. 先后顺序（负责人 #289 必改 3）：**生产要等含 #285 的版本（v0.2.0 起）上线跑稳了，另找一天再做，不和 v0.2.0 同一天；要所有者点头。** 旧版（v0.1.0）的 core 不认 `CORE_APP_DB_PASSWORD`，看到 `CORE_DB_APP_ROLE` 会走旧的 SET ROLE、切不过去、拒绝启动。脚本会检查检出的代码，#285 之前的版本直接拒绝；跑之前再用 `scripts/release-tag.sh status` 确认实际部署的就是检出的这个版本。
1. 备份：`scripts/backup.sh`。
2. 在服务器仓库目录跑 `scripts/create-app-db-role.sh`（生产，/opt/aroomo）或 `scripts/create-app-db-role.sh --staging`（staging，/opt/aroomo-staging；和 `deploy/staging/deploy-staging.sh` 用同一组 compose 参数 `-p aroomo-staging` + `deploy/staging/compose.staging.yml`）。脚本只认两个目录：生产（`PROD_ROOT`，默认 /opt/aroomo）不加 `--staging`，staging（`STAGING_ROOT`，默认 /opt/aroomo-staging）必须加；跑错地方直接退出、什么都不碰：staging 目录里不加 `--staging`、生产目录加了 `--staging`（含环境里残留 `AROOMO_STAGING=1`）、或在别的目录另检出一份去跑，都拒绝——两个环境在同一台服务器上，compose 写了 `name: aroomo`，不加会进生产的 postgres。脚本：角色不存在就建，设成 `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`，收回它在任何角色里的成员身份，授 `CONNECT`；口令在服务器上用 openssl 生成（.env 里已有就沿用），只经 stdin 进 psql，不显示、不进仓库、不经聊天；先备份 `.env` 再写 `CORE_DB_APP_ROLE`、`CORE_APP_DB_PASSWORD`（权限 600）。
3. 重建 core，日志里 `appDatabaseUrl: "(set)"`、没有「拒绝启动」，`/healthz` 通。
   - 生产：`scripts/compose.sh up -d --no-deps --force-recreate core`（`--no-deps`：不连带重建 postgres 等依赖）。如果当前版本在 `.release/compose-extra/<版本>` 里配了叠加文件，命令里要带上同样的 `-f`（`compose.sh` 不认叠加文件）。重建前后各看一次 core 用的文件，两次必须一样：`docker inspect "$(scripts/compose.sh ps -q core)" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`
   - staging：`docker compose -p aroomo-staging --project-directory deploy --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/staging/compose.staging.yml up -d --no-deps --force-recreate core`
4. 核对业务连接是 `aroomo_core_app`（compose 没给 postgres 容器设 `POSTGRES_USER`，所以默认用 `postgres`）：
   - 生产：`scripts/compose.sh exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d aroomo_core -c "SELECT usename FROM pg_stat_activity WHERE datname = current_database()"'`
   - staging：把 `scripts/compose.sh` 换成第 3 步 staging 那串 `docker compose -p aroomo-staging …` 参数。
5. 确认无误后 `.env` 加 `CORE_DB_REQUIRE_APP_ROLE=true` 再按第 3 步重建 core：以后谁把口令删了、或退回旧做法，Core 直接拒绝启动，不会悄悄降级。
- 回滚（负责人 #285 必改 1）：**`CORE_DB_REQUIRE_APP_ROLE`、`CORE_APP_DB_PASSWORD`、`CORE_DB_APP_ROLE` 三行都删掉**，重建 core，回到生产现在的样子（所有者连接，FORCE RLS 照样生效，只是注入时能被关掉）。角色留着不用删。
  - 不要只删两行留着 `CORE_DB_APP_ROLE`：那是旧的 SET ROLE 做法，要求 `aroomo_core` 是 `aroomo_core_app` 的成员。生产从来没建过这层关系，脚本建的新角色也不会加，留着这一行 Core 切不过去角色、拒绝启动。
  - 某个环境确实要退回 SET ROLE：先核 `SELECT pg_has_role('aroomo_core', 'aroomo_core_app', 'MEMBER');`，是 true 才能留 `CORE_DB_APP_ROLE` 那一行。
  - staging 打开后先按这里演练一次回退，再切回来（负责人 #285）。
  - staging 已于 2026-11-06 打开 `CORE_DB_REQUIRE_APP_ROLE=true`：两账号越权测试 30/30、回退演练一次后已切回。生产仍未打开。
- 新装：`deploy/postgres/20-aroomo-dbs.sh` 只建了 NOLOGIN 的 `aroomo_core_app`，首次启动后同样跑一次第 2 步（仓库不在 /opt/aroomo 时先设 `PROD_ROOT=<仓库目录>`）。
- 带 needs-leader-review 且负责人未审的 RLS PR 不上生产（D202/D209）。**生产什么时候打开由所有者 / 负责人定**，本脚本不会自己动生产。

### 其他规矩
- 审计日志红线：每次启动授权后接着 `REVOKE UPDATE, DELETE ON audit_log`、`REVOKE INSERT, UPDATE, DELETE ON core_schema_migrations`、收回 TRUNCATE 和只追加表的 DELETE（`core/src/db/app-role.ts`），应用角色只能追加审计。
- 新迁移建的表自动带上应用角色的 DML 权限（`ALTER DEFAULT PRIVILEGES`），不用每个迁移里写 GRANT；建 RLS 表必须 ENABLE + FORCE，漏了 FORCE 启动自检就拒绝启动。
- pg-boss（若启用）用表所有者连接，但只用自己的 schema，不碰业务表。
- 已知限制：Core 容器里还放着所有者的连接串（`CORE_DATABASE_URL`，迁移和 pg-boss 要用）。所以独立登录挡住的是 SQL 注入关掉 RLS，挡不住有人拿到容器的执行权限。
- 这里不需要新迁移：角色是整个数据库集群的对象，迁移用的 `aroomo_core` 没有建角色的权限；表权限每次启动幂等地授，没有可回退的表结构变化。
