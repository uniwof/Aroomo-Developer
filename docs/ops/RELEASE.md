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
scripts/release-tag.sh deploy v0.1.0                 # 演练：检查 + 更新日志，不切换（会提示输入 GitHub 只读令牌，不回显）
scripts/release-tag.sh deploy v0.1.0 --confirm v0.1.0   # 真正切换（同样提示输入令牌）
scripts/release-tag.sh rollback                      # 演练：显示将回到哪个版本
scripts/release-tag.sh rollback --confirm <版本>      # 一键回滚到上一个
scripts/release-tag.sh rollback --confirm v0.1.0 --lobe-session-ok  # 明确要回 LobeHub 旧登录时才用（见「回退到 v0.1.0」）
```

- 演练和确认之间，日志会写「**需要主会话：确认生产切到标签版**」。没有带正确 `--confirm` 的调用永远不会切换。
- `--confirm` 的版本号必须和要部署的一致（写两遍防手滑）。回滚时写演练里显示的版本。
- 状态在 `/opt/aroomo/.release/{current,previous,history.log}`（不含密钥，已被 `.gitignore` 忽略）。
- **令牌（#352 M1）**：`deploy` 时脚本自己用 `read -rs` 从标准输入读 GitHub 只读令牌（终端上提示、不回显；也可 `< 只读文件`）。**不要 `export GH_TOKEN`**：脚本一启动就把环境里的 `GH_TOKEN` 清掉，令牌只作为调用 `merge-gate.py` 那一条命令的环境变量传入，生产前检查、控制台构建、`docker compose` 都拿不到。建议用 fine-grained PAT，Repository access 选「Public repositories（只读）」、不加额外权限，有效期 ≤90 天，由所有者持有，不放服务器。`rollback` 不读令牌。
- **没有本地 `--hotfix`（#352 M3）**：紧急修复的豁免只认 GitHub 上该 PR 的 `hotfix` 标签（由合并闸门判定）；给 PR 加上 `hotfix` 标签后照常 `deploy`。传 `--hotfix` 会被拒绝。离线应急出口不在 #171 做，要做另开工单、由所有者决定。
- **首个可部署标签**必须在 #351（`merge-gate.py`）和 #352 一起合入 main **之后**再打。更早的标签里没有 `scripts/ci/merge-gate.py`，`deploy` 会拒绝（预期如此）；要回到它们只能走 `rollback`。待审 PR 清空前发布会一直被闸门拒绝，这是闸门要的效果。

## 切换时脚本做什么

演练和真切换都会先做下面 1–5（全部只读，不改服务器）；只有带正确 `--confirm` 才继续往后。

1. `git fetch`（只读 `origin/main` 与标签；**不加 `--force`**，本地 `v*` 标签与远端不一致就停下查原因）。
2. 拒绝：不是 `vX.Y.Z` 形式、标签不存在、标签不在 main 上（dev 上的标签、分支名、提交号都不行）；**目标标签比当前已部署的标签旧**（按 `vX.Y.Z` 版本号比，`sort -V`）也拒绝，提示「请改用 rollback」（#352 M4）。当前记录是提交号（第一次从 dev 切到标签）时按提交历史比：目标标签的提交是当前提交的祖先（更旧）也拒绝（#353；两者没有祖先关系时判断不了、放行——生产 dev→main 用合并提交，祖先关系在）。
3. **工作区必须干净**：已跟踪的文件有手工改动就拒绝，只列文件名（不列内容）。切换不加 `--force`，不会悄悄丢掉服务器上的修改，也不会覆盖同名的未跟踪文件（git 拒绝就停下）。
4. **`deploy/.env` 自检**（演练也做）：有 `CORE_CHAT_TOKEN`、`KEY_VAULTS_SECRET` 是合法密钥；不合格当场拒绝，不等到切换那一刻，更不会拖到回退时才失败。
5. **数据库迁移不超前**：只读查 `core_schema_migrations`，和目标版本 `core/migrations/` 比对；数据库里有目标版本不认识的迁移就拒绝（部署旧版本、回滚都一样）。
6. 合并闸门（#189 / #351）：跑目标版本里的 `scripts/ci/merge-gate.py`（传 `REPO`、`TAG_SHA`=标签提交、`TAG_NAME`，**固定 `MERGE_GATE_READONLY=1`**；令牌只在这一条命令上传入，不写文件、不打印）。仓库里有带 `needs-leader-review` 且无 `leader-approved` 的 PR → 非零退出 → **拒绝发布**（演练也查）。**失败即关闭**：目标版本没有 `merge-gate.py`、没读到令牌、服务器没有 `python3`，都拒绝。**只读（#352 M2）**：服务器上的闸门绝不发写请求；被检查的 PR 带 `hotfix` 标签时照样放行，但不写跟踪评论/标签——补审跟踪由 CI 的 merge-gate 工作流（非只读）在 `v*` 标签推送时写。没有本地跳过开关。
7. 生产前检查 + 部署前备份（#229，见下节）：`scripts/release-precheck.sh` 必须存在且通过，缺了或不过都拒绝部署。演练时只检查、不备份。
   - 第 6、7 步**用目标版本里的脚本**：脚本从 `git archive <标签> scripts`（连同 `core/migrations`，precheck 检查 1 要看待执行的迁移）取出到临时目录再运行（`RELEASE_ROOT` 仍指向生产目录）。因为只有新版本知道自己要跑哪些迁移；也因为生产现在的版本里根本没有这些脚本。
8. `git checkout <标签>`（不加 `--force`）→ 控制台有改动才重建 → `build core shell` → `up -d --remove-orphans` → 健康检查（core、lobe、shell 都 healthy，最长 7 分钟）。compose 的输出写进 `.release/compose.log`（权限 600，不含 `.env` 的值），出问题看这里。
9. 任何一步失败：先判断**数据库是不是已经迁移过了**——
   - 迁移本身失败：整个迁移在一个事务里，数据库没变 → 照常**自动回到切换前的版本**并记日志。
   - 新版本迁移成功、之后才失败（比如健康检查超时）：数据库里有回退目标不认识的迁移（RLS 的 FORCE + CHECK 就是这种），旧代码不会设置 `app.user_id`，什么都读不到、写入也失败。这时**不自动回退**，日志写「**需要人工处理：先用部署前备份恢复（BACKUP.md），再回滚代码**」，代码停在新版本、`.release/current` 仍记录旧版本（不假装成功）。恢复步骤见 [BACKUP.md](BACKUP.md)。
   - 读不出迁移记录：同样不自动回退，写「需要人工处理」。
   - `rollback` 命令同样先做这个检查：数据库已迁移到更新的版本时拒绝，不让你只退代码。
10. **回退目标的 Shell 登录方式**（演练也做）：`rollback` 的目标、以及 `deploy` 失败时会自动回到的当前版本，如果它的 `deploy/docker-compose.yml` 写死 `SHELL_AUTH: lobe-session`（v0.1.0 就是），又没有配版本专属叠加文件，就拒绝——切过去 Shell 只认 LobeHub 登录，而 LobeHub 已停，所有者进不去。配法见下节「回退到 v0.1.0」；确实要回旧登录时加 `--lobe-session-ok`。

脚本把自己复制到 `/tmp` 再执行，所以检出新标签不会改到正在运行的脚本。

## 生产前检查 + 部署前备份（`scripts/release-precheck.sh`，#229）

`release-tag.sh deploy … --confirm …` 切换前自动先跑；也可单独跑：`scripts/release-precheck.sh`（加 `--no-backup` 只检查）。任何一项不过就退出码 1，不部署。全程只读（数据库连接带 `default_transaction_read_only=on`），不打印数据内容，只输出表名和数量。

| 项 | 做什么 | 不过时 |
|----|--------|--------|
| 检查 1 | 只查开了 RLS 的表（清单 `scripts/lib/rls-tables.txt`：members、public_memory、public_memory_versions、library_items、vault_secrets、inbox_items、provider_keys，以及 0025–0027 的 conversations、conversation_messages、assistants、assistant_members、assistant_runs、run_steps），数 `user_id = ''` 和 `user_id IS NULL` 的行 | 列出「表=行数」。空串：RLS 迁移的 `CHECK (user_id <> '')` 会失败。NULL：`CHECK` 对 NULL 放行，但 RLS 下这些行谁都看不见；只有迁移会先回填的表（`BACKFILL_NULL=(inbox_items provider_keys)`，0023/0024）可以有 NULL。清单里的表不存在、查询出错都算失败——**唯一例外**：表不存在、且目标版本 `core/migrations/` 里还没执行（不在 `core_schema_migrations`）的迁移会 `CREATE TABLE` 它，打一行「将由本次待执行的迁移新建」放行（新表是空的；比如 v0.2.0 第一次带上 0025–0030）。迁移已记为执行过但表不存在、迁移目录或迁移记录读不出来，都照旧失败（`RELEASE_MIGRATIONS_DIR` 可改迁移目录，默认脚本旁边的 `../core/migrations`）；清单外带 `user_id` 的表只打一行信息，不拦发布。以后新增 RLS 迁移要同步改清单 |
| 检查 2 | 按迁移后的表达式（`coalesce(user_id,'owner')` + 各唯一索引原有列和条件）试算 `inbox_items`、`members`、`vault_secrets`、`library_items`、`public_memory`、`executors` 有没有重复 | 列出「表=重复组数」；典型：收件箱里 NULL（旧所有者）和 `'owner'` 有同一条 open 记录，迁移 0023 把 NULL 改成 `'owner'` 后撞 `inbox_open_dedup_uq` |
| 检查 3 | 逐表行数能读出来，存到 `.release/precheck-<时间>.counts.tsv` | 读不出来 = 失败；部署后可以对照 |
| 检查 4 | 生产 `deploy/.env` 里 Shell 所有者已设置，按 `SHELL_AUTH` 分（没写按 compose 默认 `core-session`）：`core-session` 要 `SHELL_OWNER_EMAIL` 恰好一行、非空、含 @；`lobe-session`（回退旧登录）要 `SHELL_OWNER_USER_ID` 恰好一行且非空（#252）。**不打印值** | 没有 .env、`SHELL_AUTH` 不是这两个值（含 off）、对应项缺失/为空/空引号/等号后空白/被注释/出现两行、邮箱不含 @ = 失败 |
| 检查 5 | MCP 专用网段（`.env` 的 `MCP_NET_SUBNET`，默认 `172.29.77.0/29`）有没有和主机上别的 docker 网络（`docker network inspect`）或路由（`ip route`）重叠；Aroomo 自己的 `aroomo_aroomo-mcp` 不算 | 冲突 = 失败，提示改 `MCP_NET_SUBNET` 和 `CORE_MCP_IP`；读不出网络或路由也算失败 |
| 检查 8 | （#277）`core_schema_migrations` 里已执行的迁移（符合 `NNNN_name.sql`）在目标版本迁移目录里都要有同名文件 | 缺了 = 失败并列出文件名（要上线的版本比数据库旧、标签打错、迁移文件改名或删了）；迁移目录或迁移记录读不出来也失败。没有跳过开关：回到旧版本只走 `rollback`（见「回退到 v0.1.0」） |
| 备份 | 调用 `backup now`（主密钥公钥加密 → R2；强制 `BACKUP_CHECK=always`），核对：状态 ok、`offsite:true`、**`checked:true`（已从 R2 重新下载核对 SHA-256 和 age 文件头）**、大小 > 0、备份名在 **R2 远端**列表里**完全相等**（`backup snapshots --from offsite`，不是本地目录，不做子串匹配）。上传后 `backup.sh` 还会比对 R2 上文件大小与本地 `size_bytes`，不等就失败 | 任一不满足 = 失败 |

- 检查有失败时**不做备份**（先修数据再备份）。通过的备份名记在 `.release/precheck.ok`。
- 这台机器没有主密钥（D64），备份能不能解开只靠恢复演练验证（见 [BACKUP.md](BACKUP.md)）。
- 查到问题怎么办：不要手工改生产数据，把输出（只有表名和数字）交给后台线/负责人，决定怎么清理，再重跑。
- 生产实际执行前，日志写「**需要主会话：确认执行生产检查**」，由主会话在服务器上跑。
- 测试：`scripts/test-release-precheck.sh`（真 PostgreSQL + 假备份命令；需要 `RELEASE_TEST_PSQL` 或 `psql`+`PGHOST`，否则跳过）。覆盖：干净库通过、NULL 与 owner 撞索引失败、不同账号同内容不算撞、空串 user_id 失败（library_items、provider_keys）、NULL user_id 在回填清单外的表里失败/清单内的表放行、备份失败/没上传 R2/没从 R2 重新核对/大小 0/不在 R2 列表里/只是名字子串 都拒绝、检查失败不备份、`--no-backup` 不备份、连不上库失败、不改数据；另覆盖：清单外的表有 NULL/空串照样通过、清单里的表不存在或查询出错失败、清单文件丢失失败、检查 4 两种登录方式：core-session 下只有 SHELL_OWNER_EMAIL 即通过、缺失/为空/空引号/不像邮箱/注释/重复失败，SHELL_AUTH=off 失败；lobe-session 下 SHELL_OWNER_USER_ID 缺失（只有 SHELL_OWNER_EMAIL 也算缺失）/为空/空引号/注释/重复失败；都不打印值、网段被别的 docker 网络或路由占用失败（自己的 MCP 网络不算）、读不出网络失败、**第一次部署（脚本从临时目录跑、生产目录没有 scripts/lib/）能通过**；检查 1 的待执行迁移：0025–0027 的表还不存在且迁移待执行 → 通过并列出迁移号，迁移已记为执行过但表不存在 → 失败，迁移记录表或迁移目录读不出来 → 失败，只在注释里出现的 CREATE TABLE 不算（#278：整行 `--`、行尾 `--`、单行和跨行 `/* */` 都去掉；`/* x */ CREATE TABLE`、`IF NOT EXISTS public."…"` 照旧认），没人新建的表（vault_secrets）照旧失败；检查 8：都对上通过，库里多一条（0099）或目标版本少一个（0010）失败并列出文件名，不像迁移文件名的记录不核对，迁移记录或迁移目录读不出来失败。

## 脚本绝不做的事

- 不 `git clean`、不 `git add -A`、不 `git stash -u`：服务器上有两个本地密钥文件 `deploy/.lobehub-cli-key`、`deploy/.r2-readonly.env`（已加进 `.gitignore`，但仍不能靠清理命令碰它们）。
- 不打印 `deploy/.env` 的任何值；`.env` 缺 `CORE_CHAT_TOKEN` 或 `KEY_VAULTS_SECRET` 不是合法密钥时**拒绝并回退**，不自动生成或重写（生产里已有加密数据，换密钥会让它打不开）。
- 不动 `main`；不动数据卷。

## 回滚方案（一页）

**触发条件**（满足任一，主会话决定回滚）：
- 切换后健康检查没过（脚本已自动回退；只有「需要人工处理」时才走下面的人工步骤）。
- 切换成功但：所有者登录不了；`/aroomo/auth/me` 匿名不再 302 到登录页；GlitchTip 新错误明显上升；核心功能（聊天、确认卡）不可用。
- 发现这一版有可利用的越权、泄密或花钱问题。

**一键回滚到上一个标签**（服务器 `/opt/aroomo`）：
1. `scripts/release-tag.sh status` 看当前/上一个版本。
2. `scripts/release-tag.sh rollback`（演练：打印回滚目标、做迁移核对和 Shell 登录方式核对）。
3. 主会话确认后：`scripts/release-tag.sh rollback --confirm <演练里显示的版本>`。
4. 核对：`status` 显示已回到上一个；匿名访问 `/aroomo/auth/me` 302 到 `/aroomo/login`；所有者能登录。

**数据库注意点**：
- 这一版**没执行新迁移**：直接 `rollback`，数据不动。
- 这一版**执行了新迁移**：`rollback` 会拒绝（旧代码读不了新结构）。RLS 迁移（0037–0039）的回退顺序和 `core_settings` 兼容性见 [RLS.md](RLS.md)：回滚到早于 0037 的标签前，必须先由表所有者依次执行 0039、0038、0037 的 down（或恢复备份）。先用部署前备份恢复（备份名在 `.release/precheck.ok`，步骤见 [BACKUP.md](BACKUP.md)，要所有者的主密钥），或按 `core/migrations/down/` 人工退，**再** `rollback`。会丢掉上线后写进新表的数据。
- **回滚目标必须在 `origin/main` 上**（#353）：只查服务器本地已有的 `origin/main` 记录，不联网；不在上面（比如 dev 上的提交）就拒绝。
- **不要 force-push 改写 main 的历史**：一旦远端 main 被改写、服务器 `fetch` 到新的 `origin/main`，原来的版本就不再是它的祖先，`rollback` 会拒绝（失败即关闭，是有意的）。真发生了，先找负责人和所有者，不要绕过这个检查。
- 永远不要用 `deploy` 部署更旧的标签来回退：`release-tag.sh` 会拒绝（目标标签比当前旧，提示改用 rollback，#352 M4）。
- **回滚不受合并闸门限制**（#352 M5）：`rollback` 不读令牌、不跑闸门，GitHub 不可用、令牌过期时仍能紧急回滚（测试钉死：闸门会失败且无令牌时 `rollback --confirm` 照样成功）。
- 回到 v0.1.0 还要先配叠加文件、删应用角色那三行 `.env`（见下面「回退到 v0.1.0」）。

**预计耗时**：只回代码 ≈ 5–10 分钟（重建 core/shell 镜像 + 健康检查最长 7 分钟）；要先恢复数据库 ≈ 30–60 分钟（取决于备份大小和所有者拿主密钥的时间）。

## 第一次从 dev 切到标签

服务器现在在 dev 分支的某个提交上（不是标签；写本节时是 `e2a5b09`），那个版本里**没有** `release-tag.sh` 和 `release-precheck.sh`。第一次切换时 `previous` 记的是那个提交号，所以首次切换失败或需要回滚，都会回到它（前提是数据库没被新迁移改过，见上节第 9 步）。

**首次切换之前先确认**：服务器当前检出的提交在 `origin/main` 上（是它的祖先），否则以后手动 `rollback` 回到它会被拒绝（切换失败时的自动回退不经过这个检查，不受影响）：

```bash
cd /opt/aroomo && git fetch origin main && git merge-base --is-ancestor HEAD origin/main && echo 在main上
```

没有输出「在main上」就先停下，找负责人确认首次切换方案。

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

1. **建应用角色**：数据库初始化脚本只在全新的空库上执行，生产库早就存在，所以 `aroomo_core_app` 不会自动创建。阶段 3 起用 `scripts/create-app-db-role.sh` 建独立可登录的应用角色并写 `.env`，步骤见 [RLS.md](RLS.md)「改成独立登录」（D213 第 13 项，第二个用户进生产前必须）。**先在 staging 上照着做一遍。**
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

## 回退到 v0.1.0（阶段 1.5 起；生产 Shell 不是 v0.1.0 自己的构建）

现状（2026-11-06 核对）：生产代码是 `v0.1.0`，但 Shell 用的是树外叠加文件 `/opt/aroomo-overrides/prod-shell-core-auth.yml` 钉住的镜像 `aroomo-shell:core-auth-0f1895d`（`SHELL_AUTH=core-session`，2026-11-05 换上）。`v0.1.0` 自己的 compose 写死 `SHELL_AUTH: lobe-session`，而 LobeHub 已停。所以：

- **不叠这个文件回到 v0.1.0 = 所有者进不去控制台。** `release-tag.sh` 现在会拦：没配叠加文件时 `rollback` 演练、确认都拒绝；`deploy` 新版本时，因为失败会自动回到 v0.1.0，演练也会先拒绝。
- **部署 v0.2.0 之前**（一次性，主会话在服务器上做；只新建一个文本文件，不改 `.env`、不删东西）：

```bash
mkdir -p /opt/aroomo/.release/compose-extra
cat > /opt/aroomo/.release/compose-extra/v0.1.0 <<'X'
# 回到 v0.1.0 时叠加 core-session 的 Shell（v0.1.0 的 compose 写死 lobe-session，LobeHub 已停）
/opt/aroomo-overrides/prod-shell-core-auth.yml
# shell 用叠加文件里钉住的镜像，不用 v0.1.0 的代码重建（否则会覆盖 aroomo-shell:core-auth-0f1895d 这个标签）
nobuild: shell
X
docker image inspect aroomo-shell:core-auth-0f1895d >/dev/null && echo 镜像在
bash /tmp/rt.sh deploy v0.2.0          # 演练：应打印「切换失败时会自动回到 v0.1.0 时会叠加：/opt/aroomo-overrides/…」
```

- 有了它之后，切到 v0.1.0（`rollback`，或 v0.2.0 切换失败自动回退）时脚本会：照 `compose.sh` 的同一组文件（`docker-compose.yml` + `tiers/standard.yml`）再加 `-f /opt/aroomo-overrides/prod-shell-core-auth.yml` 直接调 `docker compose`（v0.1.0 的 `compose.sh` 不认叠加文件）；只 `build core`；`up -d --remove-orphans --no-build`（镜像缺了宁可失败，不悄悄造一个旧登录的同名镜像）。日志写「叠加：…；不重建：shell」。
- **`/opt/aroomo-overrides/prod-shell-core-auth.yml` 和镜像 `aroomo-shell:core-auth-0f1895d` 在不再需要回到 v0.1.0 之前都不能删**（`docker image prune -a` 会删掉没在用的镜像：v0.2.0 上线后这个镜像就没在用了，清理镜像前先确认）。新版本自己的 compose 默认 `core-session`，不需要叠加文件。
- **打开了独立登录的应用角色以后**（[RLS.md](RLS.md)「改成独立登录」）要回退到 #285 之前的版本（v0.1.0）：**先删 `deploy/.env` 里 `CORE_DB_REQUIRE_APP_ROLE`、`CORE_APP_DB_PASSWORD`、`CORE_DB_APP_ROLE` 三行，再回退。** 旧版 core 不认 `CORE_APP_DB_PASSWORD`，留着 `CORE_DB_APP_ROLE` 会走旧的 SET ROLE、切不过去、起不来（负责人 #289 必改 3）。
- 文件格式：`.release/compose-extra/<版本>`（标签名，或提交号前 7 位），一行一个叠加文件的绝对路径；`nobuild: 服务名…` 列出不重建的服务；`#` 起是注释。列的文件不存在就拒绝切换。

### 跨过 0025–0030 回退：先恢复数据库

**回退不跑生产前检查（含检查 8）**：`release-tag.sh` 只在 `deploy` 时调 `release-precheck.sh`，`rollback` 不调；数据库比回退目标新时由 `rollback` 自己的迁移核对拒绝（第 9 步）。所以顺序永远是**先退库**（下面用部署前备份恢复；或按 `core/migrations/down/` 的回退 SQL 人工退），**再换版本**。不要用 `deploy` 部署一个更旧的标签来回退——`release-tag.sh` 会直接拒绝（目标比当前旧，#352 M4），检查 8 也会拦。

v0.2.0 会执行迁移 0025–0030（会话、助手、运行、存库、推送、步骤；0025/0026/0027/0029 带 FORCE RLS）。执行之后数据库里有 v0.1.0 不认识的迁移，`rollback` 会拒绝（第 9 步）。顺序：

1. 记下切换时的部署前备份名（`.release/precheck.ok`，或日志里的「部署前备份：aroomo-…」）。
2. 按 [BACKUP.md](BACKUP.md) 用这个备份恢复 `aroomo_core`（要主密钥；会丢掉上线后写进新表的数据——新表都是阶段 1.5 起才有的会话/助手数据）。
3. `bash /tmp/rt.sh rollback`（演练，应显示会叠加 override）→ `rollback --confirm v0.1.0`。
4. 核对：`docker inspect aroomo-shell-1 --format '{{.Config.Image}}'` = `aroomo-shell:core-auth-0f1895d`；匿名访问 `/aroomo/auth/me` 302 到 `/aroomo/login`；她能登录。
5. 还不行：让她临时回 staging（v2.2 §9）。

只有迁移**没执行**（切换在迁移前就失败）时，脚本会自动回到 v0.1.0（同样会叠加 override），不需要恢复数据库。

## 测试开关只在测试模式下生效（#353）

`release-tag.sh` 的测试开关**只在 `RELEASE_TEST_MODE=1` 时生效**：`RELEASE_REMOTE`、`RELEASE_MAIN_BRANCH`、`RELEASE_DB_CMD`、`RELEASE_PRECHECK_DB`、`RELEASE_HEALTH_CMD`、`RELEASE_REQUIRE_GATE`、`RELEASE_REQUIRE_PRECHECK`、`RELEASE_DOCKER`、`RELEASE_SKIP_CONSOLE`，以及 `release-precheck.sh` 会继承的桩 `RELEASE_PSQL`、`RELEASE_BACKUP_CMD`、`RELEASE_SNAPSHOTS_CMD`、`RELEASE_DOCKER_NETS_CMD`、`RELEASE_IP_ROUTE_CMD`、`RELEASE_MCP_NET_NAME`、`RELEASE_MIGRATIONS_DIR`。

- **生产上（不设 `RELEASE_TEST_MODE`）**：设了上面任何一个（非空，哪怕值是 1）就**拒绝并列出名字**，不悄悄忽略；没设时一律用安全默认值：`origin`、`main`、compose 里只读的 psql、真实健康检查、闸门和生产前检查必跑。
- **生产服务器整机禁用测试模式**：机器上只要存在 `/opt/aroomo`，不论 `RELEASE_ROOT` 指向哪个目录（包括别的仓库副本），设 `RELEASE_TEST_MODE=1` 都直接拒绝；`RELEASE_ROOT` 规范化后是 `/opt/aroomo`（含软链接、多余的 `/`、`..`）时同样拒绝。生产的身份是 compose 项目 `aroomo` 和它的数据卷，不只是路径。
- **会被 docker / compose 继承的变量**：不设测试模式时，`DOCKER_HOST`、`DOCKER_CONTEXT`、`COMPOSE_PROJECT_NAME`、`AROOMO_LOCAL`、`AROOMO_DATA_DIR` 设了（非空）就拒绝并列出名字。`COMPOSE_PROFILES` 不拒绝（生产 `.env` 用它启用 tunnel 和 backup），但**发布时 shell 里不要另外设 `COMPOSE_PROFILES`**，以 `.env` 为准。
- **档位**：`RELEASE_TIER` 只许小写字母（`^[a-z]+$`），且 `deploy/tiers/<档位>.yml` 必须存在，否则拒绝（测试模式和生产都校验）。
- **临时副本**：脚本把自己复制到 `/tmp/release-tag.XXXXXX` 再运行、退出时删掉。环境里继承来的 `RELEASE_TAG_COPY` 只有在等于正在运行的脚本、形如 `/tmp/release-tag.XXXXXX`、是普通文件时才认，否则不删它、重新复制。
- `RELEASE_TEST_MODE` 只认 `1` 或不设，别的值拒绝。被拒发生在建 `.release/` 之前，生产目录里不写任何东西。
- 合并闸门的仓库与 `python3` 仍然写死，不受任何环境变量影响（#352 N1）。
- 单独运行 `release-precheck.sh` 时它自己的桩变量不受这里约束（本单只改 `release-tag.sh`）。

## 测试

`scripts/test-release.sh`（以 `RELEASE_TEST_MODE=1` 运行）：临时 git 仓库 + 假的 compose，不需要 docker。覆盖列标签、拒绝 dev 标签/分支/不存在的标签、演练不切换、写错确认不切换、切换成功、坏版本自动回退（迁移没执行）、**迁移已执行后不自动回退并写「需要人工处理」**、**数据库超前时 `rollback` 演练和确认都拒绝**、**已跟踪文件有改动时演练和确认都拒绝且改动原样保留**、一键回滚、`.env` 缺项在演练时就拒绝、闸门/生产前检查取自目标版本且失败或缺失时拒绝（闸门：收到仓库/标签提交/标签名、标准输入读的令牌（环境里故意 export 的不算）、固定只读，演练也拦、没读到令牌拒绝、目标版本缺 `scripts/ci/merge-gate.py` 拒绝、本地 `--hotfix` 被拒不跳闸门、日志里没有令牌、**precheck/compose/docker 桩执行时都拿不到 `GH_TOKEN`**）、**deploy 比当前旧的标签演练和确认都拒绝**、**闸门会失败且无令牌时 `rollback` 演练和 `--confirm` 都成功、且没调用闸门**、读不出迁移记录时拒绝、本地密钥文件不被动、`compose.log` 权限 600、日志无密钥；precheck 拿到目标版本的 `core/migrations/`；回退目标写死 lobe-session 且没配叠加文件时 `deploy` 演练、`rollback` 演练和确认都拒绝，`--lobe-session-ok` 放行，叠加文件列了但不存在拒绝；配好后回滚带上叠加文件、只重建 core、`up --no-build`，没有叠加文件的版本照常走 `compose.sh`。#353 另加：不设测试模式时每个测试开关都被拒（deploy、rollback、list）且检出/current/日志都没动、闸门没跑；空串开关不算设、迁移核对确实走默认的只读 psql、list 默认只认 origin/main；`RELEASE_TEST_MODE` 非 1 拒绝；`/opt/aroomo`、`/opt/aroomo/`、`/opt/./aroomo`、`/opt/x/../aroomo`、指向它的软链接、不设 `RELEASE_ROOT` 时测试模式都被拒，且不建 `/opt/aroomo`；回滚目标在 dev 上演练/确认都拒绝、远端连不上回滚演练照样通过；首次从提交号切换时更旧的标签拒绝、同一提交或更新的放行。#353 第 2 轮另加：`RELEASE_PRECHECK_DB` 非测试模式被拒；`DOCKER_HOST`、`DOCKER_CONTEXT`、`COMPOSE_PROJECT_NAME`、`AROOMO_LOCAL`、`AROOMO_DATA_DIR` 非测试模式各自被拒并列名、`COMPOSE_PROFILES` 放行；`RELEASE_TIER` 为 `../local`、`../data-dir`、大写、带空格、带数字、档位文件不存在时都拒绝；`RELEASE_TAG_COPY` 指向任意文件、不是本脚本的 `/tmp/release-tag.*`、软链接时都不被删，正常运行不留临时副本。`scripts/test-release.sh --prod-dir-present`（CI 里 `sudo mkdir /opt/aroomo` 后跑、跑完 `rmdir`）：机器上有 `/opt/aroomo` 时在别的目录上 `status`/`list`/`deploy`/`rollback` 的测试模式都被拒，副本和 `/opt/aroomo` 里都不写东西；主测试在有 `/opt/aroomo` 的机器上直接失败退出。

两个测试脚本都在 CI 的 `release-scripts` 任务里跑（precheck 的测试用 CI 的真 PostgreSQL 服务；输出里出现「跳过」或没有「全部通过」都算失败）。

## 不做

- 不做 `release-prod.yml`（Actions 自动 SSH 发布）：需要在服务器放部署密钥、在 GitHub 存 3 个 Secrets，先由主会话 SSH 发布。
