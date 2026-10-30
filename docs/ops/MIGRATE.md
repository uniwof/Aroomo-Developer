# 服务器迁移手册（D116）

目标：换一台服务器，用户和客户端**什么都不用改**。客户端只认域名 app.pcmanai.com（D116-8），
备份在 R2（D72），主密钥只在所有者手里（D64），所以迁移 = 在新机器上恢复备份 + 把 Tunnel 接到新机器。

> 状态（2026-10-28）：脚本 `scripts/migrate.sh` 已写好，尚未在真实新机器上跑过。
> 服务器 R2 备份还没启用（`BACKUP_S3_*` 空，见 PROGRESS 阶段 A3），真实演练要等它。
> 待负责人确认：「旧机器只读保留 7 天」的做法——本手册按最保守做法写成「停服务、保留数据卷和 .env，不删机器」。

## 需要准备

| 东西 | 在哪里 | 谁 |
|---|---|---|
| 新机器：Ubuntu 24.04，≥ 4 GB 内存，amd64 或 arm64 | 任意云或自己的电脑（D116-14 不绑定云厂商） | 所有者开机器，Hark 用 SSH 部署 |
| R2 备份位置和只限该桶的令牌 | 保管库 | 所有者安全填入新机器 `deploy/.env` |
| 主密钥（AGE-SECRET-KEY-1…） | 只在所有者手里 | 所有者，只在恢复那一步输入一次 |

## 步骤

1. **新机器装好基础环境**：按 `docs/ops/` 里服务器加固做法（ufw、仅密钥登录、swap、Docker），克隆仓库到 `/opt/aroomo`，切到要部署的分支。
2. **写最小的 deploy/.env**：从 `deploy/.env.example` 生成，填备份位置四项（`BACKUP_S3_ENDPOINT`、`BACKUP_S3_BUCKET`、`BACKUP_S3_ACCESS_KEY_ID`、`BACKUP_S3_SECRET_ACCESS_KEY`），权限 600。其余值恢复后会被备份里的配置整体替换。
3. **先检查**：`scripts/migrate.sh --check`。能列出备份就说明位置和令牌都对；什么都不会改。
4. **恢复**：`scripts/migrate.sh --yes-overwrite-database`（默认最新备份；指定用 `--snapshot <名字>`）。提示时输入主密钥。脚本会：拉起数据库 → 恢复数据库和文件 → 换上备份里的配置（原 .env 另存 `.pre-migrate-*`）→ 启动主服务 → 等全部 healthy → 最后一行输出各阶段耗时 JSON。**这一步不连 Tunnel**，旧机器继续对外服务。
5. **停旧机器的 Tunnel**：在旧机器上 `scripts/compose.sh stop cloudflared`。同一个 Tunnel 两边同时连着，请求会被随机分给两台机器，数据会分叉——所以必须先停旧的。
6. **接上新机器**：在新机器上 `scripts/compose.sh up -d cloudflared`（或第 4 步直接加 `--switch-tunnel`）。用的是备份里同一个 Tunnel 令牌，域名和 DNS 都不变。
7. **验证**：打开 https://app.pcmanai.com ，登录、看历史对话、发一条消息能回复；桌面「安装为应用」的入口不用重装。
8. **旧机器保留 7 天**：`scripts/compose.sh stop`（停全部服务），**不删数据卷、不删 .env、不删机器**。7 天内新机器一切正常，再由所有者决定是否关机删除（删除属于不可逆操作，需要所有者确认）。

## 回退

新机器有问题：新机器 `scripts/compose.sh stop cloudflared`，旧机器 `scripts/compose.sh up -d`。旧机器在第 5 步之后没有新数据写入，第 5–6 步之间发生的对话会留在新机器上（最多几分钟）。

## 演练记录（D116-13）

每次演练填一行：

| 日期 | 新机器 | 备份 | 恢复耗时 | 总耗时 | 客户端是否零改动 | 记录人 |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |

CI 里的 `backup-e2e` 已覆盖「S3 目标 → 删库 → 恢复 → 核对」，但不是一台全新机器，也不含 Tunnel 切换。
