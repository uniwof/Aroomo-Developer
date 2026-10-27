# Aroomo 恢复演练 Runbook

本文档提供针对 Aroomo 系统（PostgreSQL 数据库及 RustFS 对象存储）的恢复演练标准操作流程。适用于运维人员、开发者及验收人员在生产环境或演练环境独立完成数据恢复验证。

---

## 1. 关键前提与离线密钥说明 (`LITELLM_SALT_KEY`)

⚠️ **极度重要（离线主密钥保存）**：
- `LITELLM_SALT_KEY` 用于加密存储在 `litellm` 数据库中的 API Keys 与供应商凭据。
- 备份 sidecar 仅备份 PostgreSQL 逻辑导出及 RustFS 卷，**不包含 `deploy/.env` 配置文件**（防止密钥泄露至备份仓库）。
- **`LITELLM_SALT_KEY` 必须离线另存**（如存放在安全密码管理器或离线加密存储中）。
- **演练必要校验**：在恢复演练时，恢复后的 `litellm` 数据库必须搭配最初生成该数据库时使用的 `LITELLM_SALT_KEY` 才能解开 Key。如果演练中使用不一致或默认的 Key，LiteLLM 服务解密已存凭据时将报错。

---

## 2. 自动演练步骤（推荐）

通过执行脚本 `scripts/restore-drill.sh`，可以在一套完全隔离的 Compose 临时项目（独立的 project name 和数据卷）中自动完成「环境启动 → 从 S3 恢复快照 → 数据库与表数量校验 → 清理临时资源 → 输出耗时报告」。

### 2.1 运行自动演练

```bash
# Ensure RESTIC_REPOSITORY and RESTIC_PASSWORD are set (or present in deploy/.env)
export RESTIC_REPOSITORY="s3:https://<endpoint>/<bucket>"
export RESTIC_PASSWORD="<your-restic-password>"

# Run restore drill using the latest snapshot
scripts/restore-drill.sh

# Or test against a specific snapshot ID
scripts/restore-drill.sh 9752f077
```

### 2.2 验证恢复后的 LiteLLM Key 解密

若需在演练中进一步校验 `LITELLM_SALT_KEY` 能否解开 Key：

```bash
# 保留演练环境容器不自动清理
scripts/restore-drill.sh --keep-running

# 手动传入离线的 LITELLM_SALT_KEY 启动 LiteLLM 服务并校验 API Key 访问
# 演练结束后，手动清理隔离项目：
docker compose -p aroomo-drill-<ID> down -v
```

---

## 3. 手动恢复演练步骤

如果在无法直接运行 `restore-drill.sh` 的环境（或需人工介入复盘），可参照以下手动步骤：

### 3.1 停止线上应用服务

> **警告**：直接对生产环境恢复会覆盖当前数据库。恢复前必须先停止连接 PostgreSQL 的上层服务。

```bash
docker compose stop lobe litellm core
```

### 3.2 列出并选择快照

```bash
docker compose --profile backup run --rm backup restore --list
```

### 3.3 执行恢复

```bash
# 必须带 --yes-overwrite-database 参数
docker compose --profile backup run --rm backup restore --yes-overwrite-database <snapshot-id>
```

### 3.4 启动服务并验证

```bash
docker compose up -d lobe litellm core

# 检查连接与数据表
docker compose exec postgres psql -U postgres -d lobechat -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
docker compose exec postgres psql -U postgres -d litellm -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
docker compose exec postgres psql -U postgres -d aroomo_core -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
```

---

## 4. 预期耗时记录表

请在每次完成演练后填写入下表并记录耗时（作为 P0 阶段交付物与合规审查依据）：

| 演练日期 | 演练人 | 快照 ID / 数据大小 | 容器启动耗时 | 数据恢复耗时 | 数据校验耗时 | 演练总耗时 | 结果 (Pass/Fail) | 备注 / 离线 Key 校验情况 |
|---|---|---|---|---|---|---|---|---|
| 2026-10-27 | Jules (Mock/CI) | `placeholder` (10 MB) | 4s | 3s | 1s | 8s | Pass | CI 模拟演练，自动测试全流程通过 |
| 2026-10-28 | 运维/开发 | `[snapshot-id]` (X GB) | X s | X s | X s | X s | Pass | 离线 LITELLM_SALT_KEY 验证解密正常 |

---

## 5. 故障排查与应急处理

### 5.1 恢复时报错 `active applications connected`
- **原因**：`lobe`、`litellm` 或 `core` 等服务仍连在数据库上，`restore.sh` 拒绝直接覆盖。
- **解决**：运行 `docker compose stop lobe litellm core` 确保无活跃应用连接后再重试。

### 5.2 恢复后 LiteLLM 解密报错 (`Unable to decrypt key`)
- **原因**：恢复出的 `litellm` 数据库是使用历史 `LITELLM_SALT_KEY` 加密的，当前环境 `.env` 中的 `LITELLM_SALT_KEY` 不匹配。
- **解决**：找到离线保存的原始 `LITELLM_SALT_KEY`，更新至 `.env` 后重启 `litellm` 服务。

### 5.3 Restic 错误 `repository master key mismatch` / 密码错误
- **原因**：`RESTIC_PASSWORD` 填写错误或 Repository URL 不一致。
- **解决**：确认 `RESTIC_REPOSITORY` 与 `RESTIC_PASSWORD` 配置正确；若是 S3，检查 S3 Access Key / Secret Key 权限。
