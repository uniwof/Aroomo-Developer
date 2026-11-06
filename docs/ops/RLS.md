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
1. 备份：`scripts/backup.sh`。
2. 在服务器仓库目录跑 `scripts/create-app-db-role.sh`：角色不存在就建，设成 `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`，收回它在任何角色里的成员身份，授 `CONNECT`；口令在服务器上用 openssl 生成（.env 里已有就沿用），只经 stdin 进 psql，不显示、不进仓库、不经聊天；先备份 `.env` 再写 `CORE_DB_APP_ROLE`、`CORE_APP_DB_PASSWORD`（权限 600）。
3. `scripts/compose.sh up -d --force-recreate core`，日志里 `appDatabaseUrl: "(set)"`、没有「拒绝启动」，`/healthz` 通。
4. 核对：`docker compose exec postgres psql -U "$POSTGRES_USER" -d aroomo_core -c "SELECT usename FROM pg_stat_activity WHERE datname='aroomo_core'"` 里业务连接是 `aroomo_core_app`。
5. 确认无误后 `.env` 加 `CORE_DB_REQUIRE_APP_ROLE=true` 再重建 core：以后谁把口令删了、或退回旧做法，Core 直接拒绝启动，不会悄悄降级。
- 回滚：去掉 `CORE_DB_REQUIRE_APP_ROLE` 和 `CORE_APP_DB_PASSWORD` 两行，重建 core，回到旧做法（FORCE RLS 下隔离照样在，只是注入时能被关掉）。角色留着不用删。
- 新装：`deploy/postgres/20-aroomo-dbs.sh` 只建了 NOLOGIN 的 `aroomo_core_app`，首次启动后同样跑一次第 2 步。
- 带 needs-leader-review 且负责人未审的 RLS PR 不上生产（D202/D209）。**生产什么时候打开由所有者 / 负责人定**，本脚本不会自己动生产。

### 其他规矩
- 审计日志红线：每次启动授权后接着 `REVOKE UPDATE, DELETE ON audit_log`、`REVOKE INSERT, UPDATE, DELETE ON core_schema_migrations`、收回 TRUNCATE 和只追加表的 DELETE（`core/src/db/app-role.ts`），应用角色只能追加审计。
- 新迁移建的表自动带上应用角色的 DML 权限（`ALTER DEFAULT PRIVILEGES`），不用每个迁移里写 GRANT；建 RLS 表必须 ENABLE + FORCE，漏了 FORCE 启动自检就拒绝启动。
- pg-boss（若启用）用表所有者连接，但只用自己的 schema，不碰业务表。
- 这里不需要新迁移：角色是整个数据库集群的对象，迁移用的 `aroomo_core` 没有建角色的权限；表权限每次启动幂等地授，没有可回退的表结构变化。
