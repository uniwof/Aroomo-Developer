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
