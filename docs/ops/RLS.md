# 行级安全（RLS，D206）运维说明

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
