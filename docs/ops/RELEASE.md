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

1. `git fetch`（只读 `origin/main` 与标签；**不加 `--force`**，本地 `v*` 标签与远端不一致就停下查原因）。
2. 拒绝：不是 `vX.Y.Z` 形式、标签不存在、标签不在 main 上（dev 上的标签、分支名、提交号都不行）。
3. 合并闸门（#189）：存在 `scripts/merge-gate.sh` 时先跑，仓库里还有带 `needs-leader-review` 的开放 PR 就拒绝（`--hotfix` 豁免）。闸门还没合入时只记一行提示。
4. 生产前检查 + 部署前备份（#229，见下节）：`scripts/release-precheck.sh` 必须存在且通过，缺了或不过都拒绝部署。演练时只检查、不备份。
5. `git checkout --force <标签>` → `deploy/.env` 自检 → 控制台有改动才重建 → `build core shell` → `up -d --remove-orphans` → 健康检查（core、lobe、shell 都 healthy，最长 7 分钟）。
6. 任何一步失败：**自动回到切换前的版本**并记日志；回退也失败会写「需要人工处理」。

脚本把自己复制到 `/tmp` 再执行，所以检出新标签不会改到正在运行的脚本。

## 生产前检查 + 部署前备份（`scripts/release-precheck.sh`，#229）

`release-tag.sh deploy … --confirm …` 切换前自动先跑；也可单独跑：`scripts/release-precheck.sh`（加 `--no-backup` 只检查）。任何一项不过就退出码 1，不部署。全程只读（数据库连接带 `default_transaction_read_only=on`），不打印数据内容，只输出表名和数量。

| 项 | 做什么 | 不过时 |
|----|--------|--------|
| 检查 1 | 所有带文本列 `user_id` 的表，数 `user_id = ''` 的行 | 列出「表=行数」；RLS 迁移的 `CHECK (user_id <> '')` 会因此失败 |
| 检查 2 | 按迁移后的表达式（`coalesce(user_id,'owner')` + 各唯一索引原有列和条件）试算 `inbox_items`、`members`、`vault_secrets`、`library_items`、`public_memory`、`executors` 有没有重复 | 列出「表=重复组数」；典型：收件箱里 NULL（旧所有者）和 `'owner'` 有同一条 open 记录，迁移 0023 把 NULL 改成 `'owner'` 后撞 `inbox_open_dedup_uq` |
| 检查 3 | 逐表行数能读出来，存到 `.release/precheck-<时间>.counts.tsv` | 读不出来 = 失败；部署后可以对照 |
| 备份 | 调用 `backup now`（主密钥公钥加密 → R2），核对：状态 ok、已上传异地、大小 > 0、备份名出现在 `backup snapshots` 列表 | 任一不满足 = 失败 |

- 检查有失败时**不做备份**（先修数据再备份）。通过的备份名记在 `.release/precheck.ok`。
- 这台机器没有主密钥（D64），备份能不能解开只靠恢复演练验证（见 [BACKUP.md](BACKUP.md)）。
- 查到问题怎么办：不要手工改生产数据，把输出（只有表名和数字）交给后台线/负责人，决定怎么清理，再重跑。
- 生产实际执行前，日志写「**需要主会话：确认执行生产检查**」，由主会话在服务器上跑。
- 测试：`scripts/test-release-precheck.sh`（真 PostgreSQL + 假备份命令；需要 `RELEASE_TEST_PSQL` 或 `psql`+`PGHOST`，否则跳过）。覆盖：干净库通过、NULL 与 owner 撞索引失败、不同账号同内容不算撞、空串 user_id 失败（library_items、provider_keys）、备份失败/没上传 R2/大小 0/不在列表里 都拒绝、检查失败不备份、`--no-backup` 不备份、连不上库失败、不改数据。

## 脚本绝不做的事

- 不 `git clean`、不 `git add -A`、不 `git stash -u`：服务器上有两个本地密钥文件 `deploy/.lobehub-cli-key`、`deploy/.r2-readonly.env`（已加进 `.gitignore`，但仍不能靠清理命令碰它们）。
- 不打印 `deploy/.env` 的任何值；`.env` 缺 `CORE_CHAT_TOKEN` 或 `KEY_VAULTS_SECRET` 不是合法密钥时**拒绝并回退**，不自动生成或重写（生产里已有加密数据，换密钥会让它打不开）。
- 不动 `main`；不动数据卷。

## 第一次从 dev 切到标签

服务器现在在 dev 分支的某个提交上（不是标签）。第一次切换时 `previous` 记的是那个提交号，所以首次切换失败或需要回滚，都会回到它。流程：

1. 所有者合 dev → main。
2. 主会话在 main 上打第一个标签 `v0.1.0`。
3. `list`、`deploy v0.1.0`（演练）→ 主会话确认 → `deploy v0.1.0 --confirm v0.1.0`。
4. 出问题：`rollback`（演练）→ `rollback --confirm <演练里显示的版本>`。

## 测试

`scripts/test-release.sh`：临时 git 仓库 + 假的 compose，不需要 docker。覆盖列标签、拒绝 dev 标签/分支/不存在的标签、演练不切换、写错确认不切换、切换成功、坏版本自动回退、一键回滚、`.env` 缺项拒绝、闸门/生产前检查失败或缺失拒绝、本地密钥文件不被动、日志无密钥。

## 不做

- 不做 `release-prod.yml`（Actions 自动 SSH 发布）：需要在服务器放部署密钥、在 GitHub 存 3 个 Secrets，先由主会话 SSH 发布。
