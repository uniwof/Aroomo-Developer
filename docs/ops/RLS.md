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
confirm_challenges.actor 自 0005 起就是 NOT NULL；换算函数是 STRICT，actor 为空时 CHECK 会放行，所以 actor 必须保持非空（有测试断言）。
给非主人开放 confirm:important 时，必须在 HTTP 层补 confirm.rejected 用例（A+）。
user_sessions.user_id 是 uuid，策略写 `user_id::text = …`。其余四张 text 表的非空串 CHECK 用 NOT VALID，已进 `scripts/lib/rls-tables.txt`，发布前预检查空串；上生产前清理（#229）并补 VALIDATE CONSTRAINT 迁移。
回退：`core/migrations/down/0036_rls_p0.down.sql`（回退前先备份；表所有者执行；先删约束再删列，最后删函数）。仍无 RLS 的表见 `core/test/authz/cross-account.test.ts` 的 NO_RLS_TABLES。

## core_settings（0037，#345 P1）
core_settings 加 `user_id text NOT NULL DEFAULT 'owner'`，按键名前缀回填：`u<32 位十六进制>.` → 标准 UUID 写法的账号 id，其余（所有者、vault.fp 等全局设置）→ `'owner'`；CHECK `core_settings_user_id_matches_key` 把 user_id 和键名前缀绑死。键名前缀保留（回退到旧版本照常读写）。
应用侧 `PgSettingsStore` 用同一套换算（`settingsOwnerOf`），但**范围由调用方声明，不由键名决定**：构造时显式给出归属账号（`new PgSettingsStore(db, 'owner')`；`scopedSettings(store, userId)` 经 `forAccount(userId)` 声明该账号），每次读写先断言键名换算出的账号 = 声明的账号，不一致抛错；断言过了才在该账号的 userScoped 里读写，并带 `WHERE user_id`。没有跨账号枚举，不新增 systemScoped。用量计数、负责人、规矩、工具网关定义因此进 RLS。
局限：RLS 只挡「写错的 SQL」；「声明错账号」（调用方把别人的 userId 传进 scopedSettings）RLS 挡不住，靠路由层只用会话里的 userId（D111）。内存版 `MemorySettingsStore` 无 RLS、不做该断言（只用于单元测试）。
不经 scopedSettings、直接用所有者 store（`deps.settings`，声明为 'owner'）的地方，键都不带 `u<hex>.` 前缀：`UsageService`、`LeadService`、`SecurityService`（`core/src/server.ts`）、`trialExpiryJob` 的 `TrialService`、`vaultStartupCheck`（`core/src/index.ts`，全局 vault.fp）。其中任何一处拿到带前缀的键都会被断言拒绝。
0039（#380）在回填之后去掉 `user_id` 的 DEFAULT：漏写 user_id 的 INSERT 直接 NOT NULL 报错，不会悄悄落到所有者名下。结构测试 `core/test/settings-for-account-structure.test.ts` 限定 `forAccount(` 只能在 `scopedSettings` 里调用（堵住「拿别人的 id 直接声明范围」）。
回退：`core/migrations/down/0037_rls_p1_settings.down.sql`（先跑 `0039_core_settings_drop_default.down.sql`）（回退前先备份；表所有者执行）。
**一键回滚的兼容性（#380 M2）**：`release-tag.sh rollback` 只切代码、不跑 down 迁移；它会先核对数据库已执行的迁移，目标版本不认识（含 0039）就拒绝（`migration_guard`，见 `docs/ops/RELEASE.md`「回滚方案」）。「显式写 user_id」的代码（`PgSettingsStore.set`）和 0037 在同一次合并（#369）进 dev，**至今没有任何标签包含它，没进生产**（现有标签只有 v0.1.0，不含 0036–0039）。所以：回滚到**早于该版本**的标签前，必须先由表所有者依次执行 `0039_core_settings_drop_default.down.sql`、`0038_rls_p2.down.sql`、`0037_rls_p1_settings.down.sql`（或按 RELEASE.md 用部署前备份恢复），否则 `rollback` 拒绝；回滚到**包含 0039 的**标签不受影响。UsageService 的用量计数写失败时（`record`/`recordTokens`）错误被吞掉：只是少记一次计数，不阻塞对话、也不放行或拒绝任何调用；每日次数上限目前只用于成员状态展示，不是闸门（`core/src/usage/service.ts`）。上线前核对：`core_settings` 回填后 `user_id <> 'owner'` 的行数 = 键名带 `u<hex>.` 前缀的行数（CHECK 已保证一致，迁移失败即不一致）。

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

## users / user_invites / audit_log（0038，#345 P2）
三张表都在「无账号」路径上用，策略各不相同，不加列、不回填：
- `users`：`users_self`（`id::text = app.user_id`，注册、按 id 读、改自己、管理员改目标账号都在目标账号的 userScoped 里做）+ `users_system_read`（按邮箱登录、管理员列表，systemScoped 只读）。
- `user_invites`：`user_invites_creator`（只有所有者 `app.user_id='owner'` 且 `created_by='owner'`，或**在用的管理员**（users 本人那行 role=admin、status=active）且 `created_by='user:<本人 id>'`）+ `user_invites_system_read`（按码哈希查找、管理员列表）+ `user_invites_system_redeem`（只允许系统范围 UPDATE，用于标记已用）。触发器 `user_invites_redeem_only`：任何范围的 UPDATE 只能把 `used_at` 从 NULL 改成非 NULL，其余列一律不许动。系统范围不能 INSERT / DELETE；整个 schema 里引用 `app.system_scope` 的写策略只有 `user_invites_system_redeem` 一条（`core/test/rls-p2.test.ts` 结构测试钉住）。insertInvite 的调用点只有 `users/service.ts` 的 createInvite（POST /api/users/invites）和 resetLink（POST /api/users/:id/reset-link），都在 adminGuard 后。
- `audit_log`：`audit_log_append`（INSERT 任何范围都行，含登录失败 / 系统任务；应用侧不 RETURNING）+ `audit_log_system_read`（只给 systemScoped，即所有者的 GET /api/audit）。用户范围读不到任何审计行。0001 的行级触发器在 RLS 下对看不到的行不触发，所以 0038 加语句级触发器 `audit_log_no_update_delete_stmt`：任何范围的 UPDATE / DELETE 语句都直接报错。`auditLog.query` 唯一的读取方是 GET /api/audit（`audit/routes.ts`）；登录失败锁定（`UsersService.#fails`）和接口限速（@fastify/rate-limit）都在内存计数，不读审计，所以范围错了不会让安全逻辑「计数为 0 即放行」。
- **局限（M5）**：`users_self` 允许本人改自己那行的任何列，包括 role 和 status；数据库层分不出「本人提权」和「管理员停用别人」（`user_invites_creator` 的管理员判断同样信任这一行）。这道防线只在应用层：自助接口（`/api/auth/password`、`/auth/accept`）的请求体 `additionalProperties:false` 且不收 role / status，改 role / status 只有 adminGuard 后的 `/api/users/:id/enable|disable` 和启动 seed。证据：`core/test/rls-p2-users-http.test.ts`。
- **审计保留期清理（#380）**：将来要删 `audit_log` 旧行（按保留期清理）的规矩，全部满足才能做：
  1. **何时算「执行」**：合进 dev 会自动部署到 staging 并跑迁移，所以**合入本身就是执行**。所有者本人必须在**合入 dev 之前**在 PR 评论里书面确认；合 main 和上生产仍由她本人决定。按 A+ 审查。必须是**单独的迁移**（不夹带别的改动），不得用应用代码、脚本或临时会话来删。
  2. **触发器怎么处理**：清理迁移里，只能由**表所有者在同一个事务内**暂停 `audit_log_no_update_delete_stmt` 和 0001 的行级触发器，删完后在**同一个事务内**恢复。迁移测试必须断言：迁移跑完后这两个触发器都还在、都处于启用状态，应用角色仍然没有 DELETE 权限。除此之外，不得 DROP 或停用触发器，不得给任何角色（含 BYPASSRLS）开常设的删除通道，也不得给应用角色放回 DELETE。
  3. **留痕和可恢复**：保留期的长度先由所有者拍板、写进 `docs/DECISIONS.md`；执行前确认当天的 R2 加密备份成功并且能恢复；清理迁移要**先写一条审计**（截止时间、删除的行数、批准人和 PR 号），这一条本身不在清理范围内。

回退：`core/migrations/down/0038_rls_p2.down.sql`（回退前先备份；表所有者执行；连同两个触发器和 `user_invites_redeem_only()` 函数一起删）。NO_RLS_TABLES 现在只剩 `core_schema_migrations`（永久豁免）。上生产前：应用角色需 `GRANT USAGE ON SEQUENCE audit_log_seq_seq`（grantAppRole 已含 ALL SEQUENCES）。表所有者也受 FORCE RLS 约束，pg_dump 必须用超级用户或 BYPASSRLS 角色，恢复演练对比 users、user_invites、audit_log、core_settings 四张表行数。
