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
- 角色：`aroomo_core`（能登录、表所有者）只跑迁移和授权；业务连接池 `SET ROLE aroomo_core_app`（NOLOGIN、非所有者、非超级用户）。Core 启动时自检，不满足就拒绝启动。
- 新装：`deploy/postgres/20-aroomo-dbs.sh` 已创建 `aroomo_core_app`；在 `.env` 设 `CORE_DB_APP_ROLE=aroomo_core_app`。
- 已有库（staging / 生产各做一次，需 postgres 超级用户，不涉及任何密码）：

  ```
  docker compose exec postgres psql -U "$POSTGRES_USER" -d postgres -c "CREATE ROLE aroomo_core_app NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT aroomo_core_app TO aroomo_core;"
  ```

  然后 `.env` 加 `CORE_DB_APP_ROLE=aroomo_core_app`，重建 core 容器；日志里 `dbAppRole` 显示角色名且无「拒绝启动」即生效。
- 回滚：去掉 `CORE_DB_APP_ROLE` 重建 core（FORCE RLS 下所有者同样受约束，隔离仍在）。
- 带 needs-leader-review 且负责人未审的 RLS PR 不上生产（D202/D209）。
