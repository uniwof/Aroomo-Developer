# 一页纸设计：多用户隔离（RLS + 应用数据库角色）v1（线 C，2026-11-05）

状态：设计稿，给负责人审，审过才写代码（落地方案 v2 第 3 节例外）。范围：阶段 1 在 staging 修好；阶段 3 生产启用（所有者 11-14 确认）。

## 1. 现状（已核实）
- 已有 RLS（ENABLE + FORCE，策略 `user_id = NULLIF(current_setting('app.user_id', true), '')`，系统范围只读）：`members`、`public_memory(_versions)`、`library_items`、`vault_secrets`、`inbox_items`、`provider_keys`（迁移 0019–0024）。Core 每个事务开头 `set_config('app.user_id', scope, true)`（`core/src/db/scope.ts`）。
- **staging 和生产的 core 容器里 `CORE_DB_APP_ROLE` 都是空的**（11-05 只读核对）：业务连接用的是表所有者 `aroomo_core`。FORCE 让所有者也受策略约束，所以平时隔离生效；但所有者能 `ALTER TABLE … NO FORCE` / `DISABLE ROW LEVEL SECURITY`，一旦有 SQL 注入，隔离可以被整个关掉。
- 没有 RLS、但带 `user_id` 的表：`client_tokens`、`executors`、`exec_tasks`、`exec_takeovers`；`core_settings` 按键名前缀 `u<hex>.` 分用户（用量计数、负责人、规矩都在里面）。
- 按设计不分用户的表：`users`、`user_sessions`、`user_invites`（登录本身）、`audit_log`（只追加）、`confirm_*`、`core_schema_migrations`。
- D213 第 13 项：`SET ROLE`/`options=-c role=` 挡不住会话内 `RESET ROLE`，加固前要换成可登录的独立应用角色。
- **RLS 防不了 SQL 注入**（负责人 11-05 22:22）：它只把注入后能读写的范围限在当前 `app.user_id` 的行里；防注入靠参数化查询（`$1` 占位，不拼接用户输入）。RLS 是第二道防线，不是第一道。

## 2. 要改什么（字段 / 配置）
1. **独立可登录的应用角色**：`aroomo_core_app`，`LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`，不拥有任何表，不是 `aroomo_core` 的成员（这样 `RESET ROLE` 回不到所有者）。密码由 Hark 在服务器上生成，直接写进 `.env` 的新变量 `CORE_APP_DATABASE_URL`，不经聊天、不进仓库。`CORE_DATABASE_URL`（所有者）只用来跑迁移和授权。
2. **启动自检（失败即拒绝启动）**：应用连接 `current_user` ≠ 表所有者、非超级用户、非 BYPASSRLS、拥有表数 = 0、`pg_has_role(current_user,'aroomo_core','MEMBER') = false`；对每张 RLS 表 `relforcerowsecurity = true`；**应用角色不授 TRUNCATE**（负责人 11-05 22:22：TRUNCATE 不走行级策略、不触发 DELETE 触发器，一条就能清空所有账号的数据），授权只给 SELECT/INSERT/UPDATE/DELETE，自检查到应用角色对任何表有 TRUNCATE 权限 → 拒绝启动。新增 `CORE_DB_REQUIRE_APP_ROLE=true`：设了而应用连接不满足 → 拒绝启动（staging 阶段 1 打开，生产阶段 3 打开）。
3. **补齐 RLS（同一模板，新迁移 0025 起，一表一文件，可回退）**：`client_tokens`、`executors`、`exec_tasks`、`exec_takeovers`。回填放在 ENABLE/FORCE 之前（docs/ops/RLS.md 规矩）。
4. **`core_settings`**：新迁移加 `user_id text NOT NULL DEFAULT 'owner'`，按现有键名前缀回填（`u<hex>.` → 账号 id 的标准 UUID 写法，否则 `'owner'`），再上同一策略；`scopedSettings` 改为按 `user_id` 读写（键名保留前缀一个版本，便于回退）。用量计数、负责人、规矩因此也进 RLS。
5. **方案 A 的关系**：`app.user_id` 一律取 `scopeOf(req)`；所有者自己的账号映射成 `'owner'`，RLS 不需要知道映射，策略不变。
6. **为后面新表预留（同一模板，user_id NOT NULL + 复合外键防跨账号挂接）**：复合外键 `(x_id, user_id) REFERENCES 父表 (id, user_id)` 要求父表在这两列上**先有唯一约束**（负责人 11-05 22:22）——迁移里先建 `UNIQUE (id, user_id)`（或主键含这两列），再建外键。
   - `conversations(id, user_id, title, member_ids[], created_at, updated_at, deleted_at)`、`conversation_messages(id, conversation_id, user_id, role, member_id, content, created_at)`，外键 `(conversation_id, user_id)`。
   - 助手（所有者 11-05 12:38 定：支持定时、多成员小团队、不预置；字段按指南 v1.1 附录 C，阶段 2 一次建全，代码在 `core/src/assistants/*`、执行器在 `core/src/scheduler/*`）：
     - `assistants`：附录 C 全部字段（instructions 任务说明、lead_member_id、enabled、schedule_kind/schedule_spec/timezone 计划、catch_up、max_runtime_sec、budget_level、notify、conversation_id、next_run_at、paused_at…）。
     - `assistant_members(assistant_id, member_id, role lead|worker, position)` = 成员组 + 分工；`assistant_runs(… trigger, scheduled_for, status, failure_code, summary, usage_state, message_ids)` = 运行记录。
     - **RLS 键**：附录 C 写 `owner_account_id`；我建议三张表都叫 `user_id`（含 `assistant_members`、`assistant_runs` 冗余一列），和现有 0019–0024 模板、`scopeOf`、`app.user_id` 一致，策略不用另写。复合外键 `(assistant_id,user_id)`、`(member_id,user_id)`、`(lead_member_id,user_id)` → 只能挂本人的成员，跨账号挂接在数据库层就失败。唯一键 `(assistant_id, scheduled_for)` = 定时触发的幂等键。
     - 第一版只给所有者：`assistants:read/write` 只放行 `scopeOf = 'owner'`（所有者令牌 / 方案 A 的所有者账号），家人账号 403；RLS 照样按 `user_id` 隔离，以后放开给家人不用改表。
     - **执行器和 RLS 的配合（要点）**：系统范围只有只读策略，`SELECT … FOR UPDATE` 在 RLS 下需要 UPDATE 策略，系统范围认领会被过滤成 0 行。所以分两步：① `systemScoped` 只读 `(id, user_id, next_run_at)` 找到期助手（进 systemScoped 白名单）；② 对每个助手切到 `userScoped(user_id)`，在一个事务里 `SELECT … WHERE id=$1 AND enabled AND paused_at IS NULL AND next_run_at<=now() FOR UPDATE SKIP LOCKED` → 插 `assistant_runs`（唯一键占位，重复即 skipped）→ 推进 `next_run_at`，再提交、再干活。整个运行都在建它的账号的数据范围里，不用超级权限。`ASSISTANT_SCHEDULER_ENABLED=false` 默认关；本轮不写执行器。

## 3. 谁能调用 / 返回什么
- RLS 不新增接口。现有 `userRoute` 接口照旧：账号会话 → 本人数据；所有者令牌、操作员 → `'owner'`；客户端令牌 → 令牌主人。
- 违规时的表现：读别人的行 = 不存在（404 / 空列表，与「根本没有」一致）；写别人的行 = 改到 0 行 → 404；直接 SQL 插入别人的 `user_id` → 数据库拒绝（42501）→ 500 并写审计，不回显内容。

## 4. 怎么测（全部进 CI；真 PostgreSQL 必须真跑，不允许 skipped）
1. **数据库层（每张 RLS 表一组，扩展现有 rls-*.test.ts）**：用应用角色连接；A 写一行 → 切到 B：SELECT 0 行、UPDATE/DELETE 0 行、INSERT `user_id=A` 被拒；不设 `app.user_id`：读 0 行、写被拒；`system_scope=on`：只能读不能写。
2. **角色自检**：应用角色执行 `RESET ROLE`、`SET ROLE aroomo_core`、`ALTER TABLE members NO FORCE ROW LEVEL SECURITY`、`DELETE FROM audit_log` 全部失败；用所有者连接冒充应用连接 + `CORE_DB_REQUIRE_APP_ROLE=true` → 拒绝启动。
3. **两个账号互相看不到（HTTP 层，复用 two-accounts 基建 + 方案 A 的所有者账号）**：所有者账号和小号各建成员、发一次对话、写一条规矩：互查 `/api/members`、`/api/usage`、`/api/members/:id/card`、`/api/library`、`/api/inbox`、`/api/clients`、执行员任务列表都看不到对方，按对方 id 访问与访问不存在 id 结果相同（`expectSameAsMissing`）；以后的 `/api/conversations`、`/api/assistants`（含 runs）加进同一张表。
4. **D208**：越权表遍历所有 `userRoute` 路由，新路由没声明数据范围 → CI 失败。
5. **staging 实测（阶段 1 验收第 4 条）**：备份 → 建角色、写 `.env`、重建 core → 日志里自检通过 → 用所有者账号和小号在浏览器各走一遍，互相看不到成员、用量、会话 → 截图 + 测试日志附进阶段 1 送审包。

## 5. 上线与回退
- staging：先 `scripts/backup.sh`；迁移可逆（每个文件附回退 SQL：`NO FORCE` + `DISABLE` + 删策略 + 删列）；回退 = 去掉 `CORE_APP_DATABASE_URL`/`CORE_DB_REQUIRE_APP_ROLE` 重建 core，再按需跑回退 SQL。
- 生产（阶段 3，所有者确认后）：先备份、先查 `user_id=''/NULL` 行数为 0、`core_settings` 回填条数与前缀键数一致，再启用；异常退回上一标签并恢复快照，LobeHub 照常可用。

## 6. 已定（负责人 11-05 22:22 同意）
1. `core_settings` **加 `user_id` 列**（第 2 节第 4 条），不拆独立表。
2. 应用角色密码：**staging 由 Hark 在服务器上生成**直写 `.env`（不经所有者、不经聊天、不进仓库）；**生产在阶段 3 由主会话**生成并写入。
3. 助手三张表（`assistants`、`assistant_members`、`assistant_runs`）的 RLS 键**用 `user_id`**（与 0019–0024 模板一致），不用附录 C 的 `owner_account_id`；接口里仍可叫 owner。
