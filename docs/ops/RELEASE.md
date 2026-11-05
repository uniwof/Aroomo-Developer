# 生产发布与回滚（工单 #171 / D209）

生产（app.pcmanai.com，服务器 `/opt/aroomo`）**只部署 main 上打了 `v0.x.y` 标签的版本**。staging 不受影响，仍然是 dev 合并后自动部署（见 [STAGING.md](STAGING.md)）。

## 谁做什么

| 步骤 | 谁 | 怎么做 |
|------|----|----|
| dev → main 合并 | **只有所有者** | 网页 `compare/main...dev` 开 PR 并合并。任何开发线、自动程序员都不得合 main |
| 在 main 上打标签 | 主会话 | 用 GitHub 连接器在 main 的提交上打 `v0.x.y`，写更新日志 |
| 演练 / 确认 / 切换 | 主会话（SSH） | 下面的命令。切换前必须先演练，再带 `--confirm` |

## 命令（在服务器 `/opt/aroomo` 里）

```bash
scripts/release-tag.sh list                          # main 上的标签，标出 [当前] [上一个]
scripts/release-tag.sh status                        # 当前 / 上一个版本 + 最近日志
scripts/release-tag.sh deploy v0.1.0                 # 演练：检查 + 更新日志，不切换
scripts/release-tag.sh deploy v0.1.0 --confirm v0.1.0   # 真正切换
scripts/release-tag.sh rollback                      # 演练：显示将回到哪个版本
scripts/release-tag.sh rollback --confirm <版本>      # 一键回滚到上一个
scripts/release-tag.sh deploy v0.1.1 --confirm v0.1.1 --hotfix   # 跳过合并闸门（其他检查照旧）
```

- 演练和确认之间，日志会写「**需要主会话：确认生产切到标签版**」。没有带正确 `--confirm` 的调用永远不会切换。
- `--confirm` 的版本号必须和要部署的一致（写两遍防手滑）。回滚时写演练里显示的版本。
- 状态在 `/opt/aroomo/.release/{current,previous,history.log}`（不含密钥，已被 `.gitignore` 忽略）。

## 切换时脚本做什么

演练和真切换都会先做下面 1–5（全部只读，不改服务器）；只有带正确 `--confirm` 才继续往后。

1. `git fetch`（只读 `origin/main` 与标签；**不加 `--force`**，本地 `v*` 标签与远端不一致就停下查原因）。
2. 拒绝：不是 `vX.Y.Z` 形式、标签不存在、标签不在 main 上（dev 上的标签、分支名、提交号都不行）。
3. **工作区必须干净**：已跟踪的文件有手工改动就拒绝，只列文件名（不列内容）。切换不加 `--force`，不会悄悄丢掉服务器上的修改，也不会覆盖同名的未跟踪文件（git 拒绝就停下）。
4. **`deploy/.env` 自检**（演练也做）：有 `CORE_CHAT_TOKEN`、`KEY_VAULTS_SECRET` 是合法密钥；不合格当场拒绝，不等到切换那一刻，更不会拖到回退时才失败。
5. **数据库迁移不超前**：只读查 `core_schema_migrations`，和目标版本 `core/migrations/` 比对；数据库里有目标版本不认识的迁移就拒绝（部署旧版本、回滚都一样）。
6. 合并闸门（#189）：存在 `scripts/merge-gate.sh` 时先跑（`--hotfix` 豁免）；还没有就只记一行提示。
7. 生产前检查 + 部署前备份（#229，见下节）：`scripts/release-precheck.sh` 必须存在且通过，缺了或不过都拒绝部署。演练时只检查、不备份。
   - 第 6、7 步**用目标版本里的脚本**：脚本从 `git archive <标签> scripts` 取出到临时目录再运行（`RELEASE_ROOT` 仍指向生产目录）。因为只有新版本知道自己要跑哪些迁移；也因为生产现在的版本里根本没有这些脚本。
8. `git checkout <标签>`（不加 `--force`）→ 控制台有改动才重建 → `build core shell` → `up -d --remove-orphans` → 健康检查（core、lobe、shell 都 healthy，最长 7 分钟）。compose 的输出写进 `.release/compose.log`（权限 600，不含 `.env` 的值），出问题看这里。
9. 任何一步失败：先判断**数据库是不是已经迁移过了**——
   - 迁移本身失败：整个迁移在一个事务里，数据库没变 → 照常**自动回到切换前的版本**并记日志。
   - 新版本迁移成功、之后才失败（比如健康检查超时）：数据库里有回退目标不认识的迁移（RLS 的 FORCE + CHECK 就是这种），旧代码不会设置 `app.user_id`，什么都读不到、写入也失败。这时**不自动回退**，日志写「**需要人工处理：先用部署前备份恢复（BACKUP.md），再回滚代码**」，代码停在新版本、`.release/current` 仍记录旧版本（不假装成功）。恢复步骤见 [BACKUP.md](BACKUP.md)。
   - 读不出迁移记录：同样不自动回退，写「需要人工处理」。
   - `rollback` 命令同样先做这个检查：数据库已迁移到更新的版本时拒绝，不让你只退代码。

脚本把自己复制到 `/tmp` 再执行，所以检出新标签不会改到正在运行的脚本。

## 生产前检查 + 部署前备份（`scripts/release-precheck.sh`，#229）

`release-tag.sh deploy … --confirm …` 切换前自动先跑；也可单独跑：`scripts/release-precheck.sh`（加 `--no-backup` 只检查）。任何一项不过就退出码 1，不部署。全程只读（数据库连接带 `default_transaction_read_only=on`），不打印数据内容，只输出表名和数量。

| 项 | 做什么 | 不过时 |
|----|--------|--------|
| 检查 1 | 只查开了 RLS 的表（清单 `scripts/lib/rls-tables.txt`：members、public_memory、public_memory_versions、library_items、vault_secrets、inbox_items、provider_keys），数 `user_id = ''` 和 `user_id IS NULL` 的行 | 列出「表=行数」。空串：RLS 迁移的 `CHECK (user_id <> '')` 会失败。NULL：`CHECK` 对 NULL 放行，但 RLS 下这些行谁都看不见；只有迁移会先回填的表（`BACKFILL_NULL=(inbox_items provider_keys)`，0023/0024）可以有 NULL。清单里的表不存在、查询出错都算失败；清单外带 `user_id` 的表只打一行信息，不拦发布。以后新增 RLS 迁移要同步改清单 |
| 检查 2 | 按迁移后的表达式（`coalesce(user_id,'owner')` + 各唯一索引原有列和条件）试算 `inbox_items`、`members`、`vault_secrets`、`library_items`、`public_memory`、`executors` 有没有重复 | 列出「表=重复组数」；典型：收件箱里 NULL（旧所有者）和 `'owner'` 有同一条 open 记录，迁移 0023 把 NULL 改成 `'owner'` 后撞 `inbox_open_dedup_uq` |
| 检查 3 | 逐表行数能读出来，存到 `.release/precheck-<时间>.counts.tsv` | 读不出来 = 失败；部署后可以对照 |
| 检查 4 | 生产 `deploy/.env` 里 Shell 所有者已设置，按 `SHELL_AUTH` 分（没写按 compose 默认 `core-session`）：`core-session` 要 `SHELL_OWNER_EMAIL` 恰好一行、非空、含 @；`lobe-session`（回退旧登录）要 `SHELL_OWNER_USER_ID` 恰好一行且非空（#252）。**不打印值** | 没有 .env、`SHELL_AUTH` 不是这两个值（含 off）、对应项缺失/为空/空引号/等号后空白/被注释/出现两行、邮箱不含 @ = 失败 |
| 检查 5 | MCP 专用网段（`.env` 的 `MCP_NET_SUBNET`，默认 `172.29.77.0/29`）有没有和主机上别的 docker 网络（`docker network inspect`）或路由（`ip route`）重叠；Aroomo 自己的 `aroomo_aroomo-mcp` 不算 | 冲突 = 失败，提示改 `MCP_NET_SUBNET` 和 `CORE_MCP_IP`；读不出网络或路由也算失败 |
| 备份 | 调用 `backup now`（主密钥公钥加密 → R2；强制 `BACKUP_CHECK=always`），核对：状态 ok、`offsite:true`、**`checked:true`（已从 R2 重新下载核对 SHA-256 和 age 文件头）**、大小 > 0、备份名在 **R2 远端**列表里**完全相等**（`backup snapshots --from offsite`，不是本地目录，不做子串匹配）。上传后 `backup.sh` 还会比对 R2 上文件大小与本地 `size_bytes`，不等就失败 | 任一不满足 = 失败 |

- 检查有失败时**不做备份**（先修数据再备份）。通过的备份名记在 `.release/precheck.ok`。
- 这台机器没有主密钥（D64），备份能不能解开只靠恢复演练验证（见 [BACKUP.md](BACKUP.md)）。
- 查到问题怎么办：不要手工改生产数据，把输出（只有表名和数字）交给后台线/负责人，决定怎么清理，再重跑。
- 生产实际执行前，日志写「**需要主会话：确认执行生产检查**」，由主会话在服务器上跑。
- 测试：`scripts/test-release-precheck.sh`（真 PostgreSQL + 假备份命令；需要 `RELEASE_TEST_PSQL` 或 `psql`+`PGHOST`，否则跳过）。覆盖：干净库通过、NULL 与 owner 撞索引失败、不同账号同内容不算撞、空串 user_id 失败（library_items、provider_keys）、NULL user_id 在回填清单外的表里失败/清单内的表放行、备份失败/没上传 R2/没从 R2 重新核对/大小 0/不在 R2 列表里/只是名字子串 都拒绝、检查失败不备份、`--no-backup` 不备份、连不上库失败、不改数据；另覆盖：清单外的表有 NULL/空串照样通过、清单里的表不存在或查询出错失败、清单文件丢失失败、检查 4 两种登录方式：core-session 下只有 SHELL_OWNER_EMAIL 即通过、缺失/为空/空引号/不像邮箱/注释/重复失败，SHELL_AUTH=off 失败；lobe-session 下 SHELL_OWNER_USER_ID 缺失（只有 SHELL_OWNER_EMAIL 也算缺失）/为空/空引号/注释/重复失败；都不打印值、网段被别的 docker 网络或路由占用失败（自己的 MCP 网络不算）、读不出网络失败、**第一次部署（脚本从临时目录跑、生产目录没有 scripts/lib/）能通过**。

## 脚本绝不做的事

- 不 `git clean`、不 `git add -A`、不 `git stash -u`：服务器上有两个本地密钥文件 `deploy/.lobehub-cli-key`、`deploy/.r2-readonly.env`（已加进 `.gitignore`，但仍不能靠清理命令碰它们）。
- 不打印 `deploy/.env` 的任何值；`.env` 缺 `CORE_CHAT_TOKEN` 或 `KEY_VAULTS_SECRET` 不是合法密钥时**拒绝并回退**，不自动生成或重写（生产里已有加密数据，换密钥会让它打不开）。
- 不动 `main`；不动数据卷。

## 第一次从 dev 切到标签

服务器现在在 dev 分支的某个提交上（不是标签；写本节时是 `e2a5b09`），那个版本里**没有** `release-tag.sh` 和 `release-precheck.sh`。第一次切换时 `previous` 记的是那个提交号，所以首次切换失败或需要回滚，都会回到它（前提是数据库没被新迁移改过，见上节第 9 步）。

### 第一次怎么把脚本拿到服务器上

```bash
cd /opt/aroomo
git fetch --tags
git show v0.1.0:scripts/release-tag.sh > /tmp/rt.sh
bash /tmp/rt.sh deploy v0.1.0                       # 演练：检查 + 更新日志，不切换
bash /tmp/rt.sh deploy v0.1.0 --confirm v0.1.0      # 主会话确认后真切换
```

脚本会自己再从 `v0.1.0` 里取出 `release-precheck.sh`（和闸门）来跑，所以只需要拿这一个文件。切换成功后 `/opt/aroomo/scripts/release-tag.sh` 就在工作区里了，以后直接用它。

### 上线前必须手工做的事（11-03 首次上生产）

1. **建应用角色**：数据库初始化脚本只在全新的空库上执行，生产库早就存在，所以 `aroomo_core_app` 不会自动创建。由所有者执行 `CREATE ROLE aroomo_core_app NOLOGIN; GRANT aroomo_core_app TO aroomo_core;`，再在 `deploy/.env` 里设 `CORE_DB_APP_ROLE`。不然 Core 拒绝启动。**先在 staging 上照着做一遍。**
2. 演练（`deploy v0.1.0`）里的生产前检查全绿；有失败按「生产前检查」一节处理。
3. 主会话确认后带 `--confirm` 切换。部署前备份会自动做并核对 R2。
4. 切换后若失败且日志写「需要人工处理」：**不要只回滚代码**，先用部署前备份恢复数据库（[BACKUP.md](BACKUP.md)），再回滚。

流程：

1. 所有者合 dev → main。
2. 主会话在 main 上打第一个标签 `v0.1.0`。
3. `list`、`deploy v0.1.0`（演练）→ 主会话确认 → `deploy v0.1.0 --confirm v0.1.0`。
4. 出问题：`rollback`（演练）→ `rollback --confirm <演练里显示的版本>`；数据库已迁移时会被拒绝，按上面第 4 点处理。

### 赶不上自动脚本时（手动部署）

可以按本文手动部署，但下面两件事一件都不能少：①手动跑一遍 `release-precheck.sh` 里的 SQL（或直接 `scripts/release-precheck.sh --no-backup`）；②手动备份一次并确认 R2 上有这个文件（`backup snapshots --from offsite`）。迁移执行过之后，不要只回滚代码，先恢复备份。

## 测试

`scripts/test-release.sh`：临时 git 仓库 + 假的 compose，不需要 docker。覆盖列标签、拒绝 dev 标签/分支/不存在的标签、演练不切换、写错确认不切换、切换成功、坏版本自动回退（迁移没执行）、**迁移已执行后不自动回退并写「需要人工处理」**、**数据库超前时 `rollback` 演练和确认都拒绝**、**已跟踪文件有改动时演练和确认都拒绝且改动原样保留**、一键回滚、`.env` 缺项在演练时就拒绝、闸门/生产前检查取自目标版本且失败或缺失时拒绝、读不出迁移记录时拒绝、本地密钥文件不被动、`compose.log` 权限 600、日志无密钥。

两个测试脚本都在 CI 的 `release-scripts` 任务里跑（precheck 的测试用 CI 的真 PostgreSQL 服务；输出里出现「跳过」或没有「全部通过」都算失败）。

## 不做

- 不做 `release-prod.yml`（Actions 自动 SSH 发布）：需要在服务器放部署密钥、在 GitHub 存 3 个 Secrets，先由主会话 SSH 发布。
