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

测试在 CI 的 `release-scripts` 任务里跑（输出里没有「全部通过」或有 FAIL 都算失败）。

## 不做

- 不做 `release-prod.yml`（Actions 自动 SSH 发布）：需要在服务器放部署密钥、在 GitHub 存 3 个 Secrets，先由主会话 SSH 发布。
