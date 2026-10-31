# 备份与恢复（公钥加密，age + rclone）

对应 PRODUCT §7.1、§7.6、§10.2 O1、§15.3；DECISIONS D49（备份在 AWS 之外、恢复演练）、**D64**（密钥保管）、**D65**（电脑版异地备份）。

> **修订注（2026-10-28，D64/D65）：** 原来的 restic 方案每次备份都要在服务器上持有 `RESTIC_PASSWORD`，与 D64「主密钥不得进服务器」冲突，已改为用主密钥的**公钥**加密（DECISIONS D64 实现注 a）。原来「`.env` 不备份、`LITELLM_SALT_KEY` 和 `RESTIC_PASSWORD` 另行离线保存」的要求取消：现在离线保管的只有主密钥一个，`.env` 在加密包里。旧的 restic 仓库（如果有）不再写入；需要时用 restic 0.19 和原口令手动读取。

## 1. 主密钥和公钥

| | 是什么 | 在哪里 |
|---|---|---|
| 主密钥 | age 私钥，`AGE-SECRET-KEY-1` 开头，74 个字符 | **只在用户手里**：密码管理器 + 纸质副本。不得进仓库、服务器、备份存储或任何聊天（D64）。只在恢复时临时输入 |
| 公钥 | `age1` 开头，62 个字符，不是秘密 | 服务器和电脑的 `.env`：`BACKUP_AGE_RECIPIENT` |

- 主密钥由 Windows 安装程序在用户电脑上离线生成，一次性显示，用户点「已保存」后才继续（D64 实现注 b）。服务器和电脑共用同一个主密钥（D65）：用户把窗口里的公钥发给主程序员，填进服务器 `.env`。
- 服务器和电脑只能**加密**、不能**解密**。被入侵的机器、泄露的备份存储都打不开历史备份。
- 丢了主密钥 = 所有备份都打不开。

## 2. 备份什么

每次备份是一个文件 `aroomo-<主机标签>-<UTC 时间>.tar.zst.age`，旁边一个明文 `.meta.json`（格式、算法、公钥、密文 SHA-256，D64：非秘密参数跟随备份）。加密包里：

| 内容 | 方式 |
|------|------|
| LobeHub、LiteLLM、Core 等全部业务库 | 每个库一个 `pg_dump` 文件，外加同一时刻的逐表行数（恢复后核对） |
| 角色 | `pg_dumpall --globals-only --no-role-passwords`（不含密码） |
| 对象存储（会话里上传的文件） | rustfs 数据卷 |
| 配置 | `deploy/litellm/`、`deploy/lobe/` |
| `.env` | 含 `LITELLM_SALT_KEY`（`BACKUP_INCLUDE_ENV=1`，默认开）。只能用主密钥打开 |

没有增量：每份都是完整备份（为了不在服务器上放解密口令而做的取舍）。

## 3. 备份到哪里

任意 S3 兼容存储，必须在 AWS 之外。同一个桶，服务器写 `server/`，电脑写 `pc/<电脑名>/`（D65）。在 `deploy/.env` 里填：

| 变量 | Cloudflare R2 | Backblaze B2 |
|------|---------------|--------------|
| `BACKUP_S3_ENDPOINT` | `https://<账号ID>.r2.cloudflarestorage.com` | `https://s3.<区域>.backblazeb2.com` |
| `BACKUP_S3_BUCKET` | 桶名 | 桶名 |
| `BACKUP_S3_PREFIX` | 服务器 `server`（默认）；电脑由安装器写 `pc/<电脑名>` | 同左 |
| `BACKUP_S3_REGION` | `auto` | 区域，如 `us-west-004` |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | R2 API 令牌（只给这个桶读写） | B2 应用密钥（只给这个桶） |
| `BACKUP_AGE_RECIPIENT` | 主密钥的公钥 | 同左 |

不需要建桶权限（rclone 设了 `no_check_bucket`）。

## 4. 日常

1. 服务器：`.env` 里设 `COMPOSE_PROFILES=tunnel,backup`，`scripts/compose.sh up -d`。之后每天 `BACKUP_CRON`（默认 03:30）自动备份。没填 `BACKUP_AGE_RECIPIENT` 时 sidecar 空转并在日志里说明。
2. 手动备份一次：`scripts/compose.sh --profile backup run --rm backup now`。最后一行是 JSON：`status`、`duration_s`、`snapshot_id`（备份名）、`sha256`、`size_bytes`、`offsite`、`env_included`。失败时退出码非零，并有一行中文原因。
3. 看有哪些备份：`scripts/compose.sh --profile backup run --rm backup snapshots`（加 `--from local` 看本机的）。
4. 异地保留：`RETENTION_KEEP_DAILY=7`、`RETENTION_KEEP_WEEKLY=4`、`RETENTION_KEEP_MONTHLY=6`（可改；规则与 restic 相同：同一天多份时按天只留最新一份；`RETENTION_KEEP_LAST` 另加保留最近 N 份，电脑版安装器设为 3）。本机（电脑版）只留最近 `BACKUP_LOCAL_KEEP=3` 份。
5. 完整性检查：`BACKUP_CHECK=weekly` 时每周日备份后重新下载刚上传的那份，核对 SHA-256 和 age 文件头。因为机器上没有主密钥，**能不能解开只能由恢复演练验证**（第 6 节）。
6. 备份脚本会拒绝运行的情况：没有公钥；环境变量或 `.env` 里出现了主密钥（`AGE-SECRET-KEY-1…`）；异地和本机都没配置。

## 5. 恢复（会覆盖现有数据）

1. 停服务：`scripts/compose.sh stop lobe litellm core rustfs`。
2. 准备主密钥（不要写进任何文件）：`read -rs AROOMO_BACKUP_IDENTITY; export AROOMO_BACKUP_IDENTITY`（粘贴后回车，屏幕上不显示）。
3. 恢复：`scripts/compose.sh --profile restore run --rm -e AROOMO_BACKUP_IDENTITY restore --yes-overwrite-database`（默认最新一份；可在后面写备份名或时间；`--from local` 从本机取；`--no-files` 只恢复数据库）。不设变量、直接在终端运行时，脚本会提示输入主密钥。
4. 脚本会：检查服务确实已停 → 下载 → 核对 SHA-256 → 核对主密钥与备份的公钥是否匹配 → 解密解压 → 重建数据库 → 清空并写回对象存储 → 逐表核对行数 → 输出各阶段耗时。核对不一致会失败退出。
5. 备份里的 `.env` 写到 `deploy/.restore/aroomo.env`（权限 600）。新机器上：用它替换 `deploy/.env`（特别是 `LITELLM_SALT_KEY`），然后删除 `deploy/.restore/`。同一台机器上只是回滚数据时，一般不用动。
6. `unset AROOMO_BACKUP_IDENTITY`，然后 `scripts/compose.sh up -d`。

没有 `--yes-overwrite-database` 时脚本只提示、不做任何事（退出码 64）。

## 6. 恢复演练（P0 必做，之后每月一次）

1. 在服务器仓库根目录运行：`scripts/restore-drill.sh`，按提示输入主密钥（用用户保存的那一份，演练的目的就是证明它能用）。
2. 它会另起一套临时项目（新的卷、不开端口、不碰正式数据），从最新备份恢复、核对、检查对象存储能启动，然后删除临时项目。
3. 报告写在 `drill-reports/restore-drill-<时间>.md`，含结论、备份名、每个阶段的秒数、备份里是否有 `.env`。
4. 验证 `LITELLM_SALT_KEY`：`DRILL_CHECK_LITELLM=1 scripts/restore-drill.sh`，会用恢复后的库启动 LiteLLM，检查日志里没有解密错误。之后在界面里确认成员 Key 状态正常。
5. 把结论和总耗时写进简报 / 周报。

| 日期 | 备份 | 总耗时 | 结论 | 执行人 |
|------|------|--------|------|--------|
| 2026-10-31 | aroomo-aroomo-20261031T100028Z（AWS 首份，237008 字节） | 6 秒（备份） | Hark 侧完整性通过（SHA-256 一致、age v1 X25519、无明文、错钥被拒）；解密待所有者本机核对（docs/ops/RESTORE-DRILL-OWNER.md，#195） | Hark |

> 服务器已启用（2026-10-31）：`COMPOSE_PROFILES=tunnel,backup`，每天 03:30（Asia/Shanghai）备份到 R2 `aroomo-backup/server/`，公钥见 DECISIONS D245。主密钥只在所有者 U 盘，服务器不能做第 6 节的整机演练，除非所有者在场输入主密钥；所有者侧先用本机核对小工具。

## 7. 失败时

| 提示 | 处理 |
|------|------|
| BACKUP_AGE_RECIPIENT 未设置 | 在用户电脑上生成主密钥后，把公钥填进 `.env` |
| 备份环境里出现了主密钥 | 从 `.env` / 环境变量里删掉 `AGE-SECRET-KEY-1…`，只留公钥。若它已经在服务器上存过，按 KEY-STORAGE.md 2.4 更换主密钥 |
| 连接异地存储失败 | 检查 `BACKUP_S3_ENDPOINT`、桶名、访问密钥、网络；R2 的区域填 `auto` |
| 主密钥不对 | 这份备份是另一把主密钥的公钥加密的（例如更换过主密钥）；换用对应的那把 |
| SHA-256 不一致 | 存储里的文件损坏；换上一份备份 |
| 还有程序连着数据库 / rustfs 还在运行 | 先执行第 5 节第 1 步 |
| 行数与备份不一致 | 不要启动服务；保留现场，换上一份备份再试，并通知主程序员 |
| 恢复后成员 Key 全部失效 | `.env` 的 `LITELLM_SALT_KEY` 与备份时不同，用 `deploy/.restore/aroomo.env` 里的那一个 |

## 8. 测试

- CI 的 `backup-e2e` job（`scripts/test-backup-e2e.sh`）用一个 rustfs 容器充当 S3 目标，生成一次性测试主密钥，跑完「写数据 → 公钥加密备份 → 保护检查（无公钥、环境里有私钥、无确认、服务未停）→ 异地 / 本机保留策略 → `.env` 在加密包里 → 删光数据卷 → 错的主密钥被拒 → 恢复 → 核对行数和对象内容 → 演练」，演练报告作为 artifact `restore-drill-report` 上传。
- `scripts/test-retention.sh`：保留策略单元测试（compose job）。
