# 备份与恢复（restic）

> **修订注（2026-10-28，D64/D65）：** 本文描述的 restic + `RESTIC_PASSWORD` 方案与 D64「主密钥不得进服务器」冲突，已决定改为「用主密钥的公钥（age X25519）加密」，见 DECISIONS D64 实现注 a。第 1 节「不备份 `.env`」、第 2 节 `RESTIC_*` 变量、第 3–6 节的命令由后续的备份 PR 整体改写；电脑版异地备份（D65）写在 WINDOWS.md。

对应 PRODUCT §7.1、§7.6、§10.2 O1、§15.3；DECISIONS v4.3 第 4 条、P0-e。

## 1. 备份什么

| 内容 | 方式 |
|------|------|
| LobeHub、LiteLLM、Core 三个库 | 每个库一个 `pg_dump` 文件，外加同一时刻的逐表行数（恢复后核对） |
| 角色 | `pg_dumpall --globals-only --no-role-passwords`（不含密码） |
| 对象存储（会话里上传的文件） | rustfs 数据卷 |
| 配置 | `deploy/litellm/`、`deploy/lobe/`（不含密钥） |

**不备份**：`deploy/.env`。其中 `LITELLM_SALT_KEY` 和 `RESTIC_PASSWORD` 必须由你离线另存（例如打印或存进密码管理器）。
丢了 `LITELLM_SALT_KEY`，恢复出来的成员 Key 解不开；丢了 `RESTIC_PASSWORD`，备份打不开。

## 2. 备份到哪里

任意 S3 兼容存储，必须在 AWS 之外。在 `deploy/.env` 里填：

| 变量 | Cloudflare R2 | Backblaze B2 |
|------|---------------|--------------|
| `RESTIC_REPOSITORY` | `s3:https://<账号ID>.r2.cloudflarestorage.com/<桶>/aroomo` | `s3:https://s3.<区域>.backblazeb2.com/<桶>/aroomo` |
| `BACKUP_S3_REGION` | `auto` | 区域，如 `us-west-004` |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | R2 API 令牌 | B2 应用密钥 |
| `RESTIC_PASSWORD` | 随机长口令（`openssl rand -hex 32`） | 同左 |

建议给这个桶单独建一个只能访问它的密钥。

## 3. 日常

1. 在 `.env` 里设 `COMPOSE_PROFILES=tunnel,backup`，`scripts/compose.sh up -d`。之后每天 `BACKUP_CRON`（默认 03:30）自动备份。
2. 手动备份一次：`scripts/compose.sh --profile backup run --rm backup now`。最后一行是 JSON：`status`、`duration_s`、`snapshot_id`、`size_bytes`。失败时退出码非零，并有一行中文原因。
3. 看有哪些快照：`scripts/compose.sh --profile backup run --rm backup snapshots`。
4. 保留策略：`RETENTION_KEEP_DAILY=7`、`RETENTION_KEEP_WEEKLY=4`、`RETENTION_KEEP_MONTHLY=6`（可改；`RETENTION_KEEP_LAST` 另加保留最近 N 个）。
5. 完整性检查：`BACKUP_CHECK=weekly` 时每周日备份后抽查 5% 数据（`restic check --read-data-subset=5%`）。

## 4. 恢复（会覆盖现有数据）

1. 停服务：`scripts/compose.sh stop lobe litellm core rustfs`。
2. 恢复：`scripts/compose.sh --profile restore run --rm restore --yes-overwrite-database`（默认最新快照；可在后面写快照 id；`--no-files` 只恢复数据库）。
3. 脚本会：检查服务确实已停 → 下载快照 → 重建三个库 → 清空并写回对象存储 → 逐表核对行数 → 输出各阶段耗时。核对不一致会失败退出。
4. 启动：`scripts/compose.sh up -d`。

没有 `--yes-overwrite-database` 时脚本只提示、不做任何事（退出码 64）。

## 5. 恢复演练（P0 必做，之后每月一次）

1. 在服务器仓库根目录运行：`scripts/restore-drill.sh`。
2. 它会另起一套临时项目（新的卷、不开端口、不碰正式数据），从最新快照恢复、核对、检查对象存储能启动，然后删除临时项目。
3. 报告写在 `drill-reports/restore-drill-<时间>.md`，含结论、快照、每个阶段的秒数。
4. 验证 `LITELLM_SALT_KEY`：`DRILL_CHECK_LITELLM=1 scripts/restore-drill.sh`，会用恢复后的库启动 LiteLLM，检查日志里没有解密错误。之后在界面里确认成员 Key 状态正常。
5. 把结论和总耗时写进简报 / 周报。

| 日期 | 快照 | 总耗时 | 结论 | 执行人 |
|------|------|--------|------|--------|
|      |      |        |      |        |

## 6. 失败时

| 提示 | 处理 |
|------|------|
| 备份口令不对 | `.env` 的 `RESTIC_PASSWORD` 与仓库不符，找离线副本 |
| 连不上备份仓库 | 检查 `RESTIC_REPOSITORY`、密钥、网络；R2 的区域填 `auto` |
| 还有程序连着数据库 / rustfs 还在运行 | 先执行第 4 节第 1 步 |
| 行数与备份不一致 | 不要启动服务；保留现场，换上一个快照再试，并通知主程序员 |
| 恢复后成员 Key 全部失效 | `LITELLM_SALT_KEY` 与备份时不同，换回离线保存的那一份 |

## 7. 测试

CI 的 `backup-e2e` job（`scripts/test-backup-e2e.sh`）用一个 rustfs 容器充当 S3 目标，跑完「写数据 → 备份 → 删光数据卷 → 恢复 → 核对行数和对象内容 → 演练」，演练报告作为 artifact `restore-drill-report` 上传。
