# 部署（P0）

服务器（Ubuntu 24.04 x86_64）和 Windows 本地版（WSL2 + Docker Desktop）共用这一套 Compose（PRODUCT §7、§16 P0-f）。

## 文件

| 文件 | 作用 |
|------|------|
| `docker-compose.yml` | 基础服务；**不发布任何宿主机端口** |
| `tiers/demo-2g.yml`、`standard.yml`、`full.yml` | 各档位的内存上限（**暂定值**，等 P0-b 内存实测报告定稿） |
| `local.yml` | 本机访问：只绑定 `127.0.0.1:3210`（界面）和 `127.0.0.1:9000`（对象存储） |
| `local-backup.yml` | Windows 本地版：restic 仓库放在用户数据文件夹（`LOCAL_BACKUP_DIR` → `/repo`），见 [docs/ops/WINDOWS.md](../docs/ops/WINDOWS.md) |
| `data-dir.yml` | 把数据放到 `DATA_DIR` 指定的文件夹（绝对路径，需先建好 `postgres/ redis/ rustfs/`） |
| `.env.example` | 环境变量模板（只有占位符）；复制成 `.env` 填写，`.env` 不入库 |
| `postgres/20-aroomo-dbs.sh` | 首次初始化时为 LiteLLM、Core 各建一个库和账号 |
| `litellm/config.yaml` | LiteLLM 配置（不含模型和 Key） |
| `lobe/` | LobeHub 对象存储桶初始化 |
| `backup/` | 备份 sidecar / 恢复镜像（PostgreSQL 17 客户端 + restic + jq） |
| `test/e2e.yml` | 仅测试用：备份端到端测试接入测试 S3 目标的网络 |

## 服务与镜像（2026-10-27 核实）

| 服务 | 镜像 | 说明 |
|------|------|------|
| lobe | `lobehub/lobehub:2.2.20` | LobeHub 服务器数据库版（2.x 起改名；旧 `lobe-chat-database` 已停更于 1.143.3） |
| postgres | `paradedb/paradedb:0.26.3-pg17` | PostgreSQL 17 + pgvector + pg_search（LobeHub 2.x 官方 compose 用 ParadeDB） |
| redis | `redis:7.4.12-alpine` | LobeHub 需要 |
| rustfs / rustfs-init | `rustfs/rustfs:1.0.4`、`rustfs/rc:v0.1.36` | S3 兼容对象存储（LobeHub 官方默认） |
| litellm | `ghcr.io/berriai/litellm:v1.106.4` | 成员网关；只在容器网络内 |
| core | 本仓库 `core/` 构建（`node:22.23.4-alpine3.24`） | 只在容器网络内 |
| gateway（profile `agent-gateway`） | `ghcr.io/lobehub/lobehub-gateway:0.3.2` | 可选，P0 默认关闭 |
| cloudflared（profile `tunnel`） | `cloudflare/cloudflared:2026.10.5` | 服务器对外通道 |
| backup（profile `backup`） | 本仓库 `deploy/backup/` 构建（`postgres:17.11-alpine3.24` + `restic/restic:0.19.1`） | 备份到 AWS 之外 |

以上镜像都有 linux/amd64 与 linux/arm64。

## 启动

```bash
cp deploy/.env.example deploy/.env    # 填写；随机值用 openssl rand -hex 32
scripts/compose.sh up -d               # 服务器：自动档位；.env 里 COMPOSE_PROFILES=tunnel,backup
AROOMO_LOCAL=1 scripts/compose.sh up -d   # 本机：http://localhost:3210
AROOMO_TIER=standard scripts/compose.sh config   # 指定档位并查看合并结果
```

档位选择：`scripts/select-tier.sh`，按内存 < 3500 MB → `demo-2g`（对话演示版）、< 7000 MB → `standard`、其余 → `full`（阈值暂定）。

## 访问（服务器）

- 除 22 端口外不开放任何入站端口；全部经 Cloudflare Tunnel + Cloudflare Access。
- 在 Cloudflare 控制台为 Tunnel 配置两条路由：应用域名 → `http://lobe:3210`；对象存储域名 → `http://rustfs:9000`。
- `.env` 中 `APP_URL` 填应用域名，`S3_ENDPOINT` 填对象存储域名（浏览器要能直接访问它才能在会话里上传图片）。

## Key 的存储方式

- **供应商 Key（成员的 API Key）只存在 LiteLLM。** `STORE_MODEL_IN_DB=True` 时，模型和凭据写入 `litellm` 库，由 `LITELLM_SALT_KEY` 加密（LiteLLM 官方文档：production deployment → Core configuration）。Core 通过 LiteLLM 管理 API 写入，**绝不把 Key 返回给客户端**（只显示末 4 位和状态）。
- `LITELLM_SALT_KEY` **写入第一个模型后不能更换**，否则已存的 Key 全部无法解密。它不进 restic 备份（备份仓库只靠 `RESTIC_PASSWORD` 保护），由用户离线另存一份；恢复演练时要验证用它能解开恢复后的 Key。
- `LITELLM_MASTER_KEY` 只给 Core 用于管理调用；LobeHub 用单独的虚拟 Key（`LOBE_LITELLM_VIRTUAL_KEY`）调用模型。
- LobeHub 的 `KEY_VAULTS_SECRET` 只加密 LobeHub 自己的设置；Aroomo 不在 LobeHub 里存供应商 Key。

## 备份与恢复（restic）

见 [docs/ops/BACKUP.md](../docs/ops/BACKUP.md)。要点：目标为 AWS 之外的 S3 兼容存储（R2 / B2）；每库 `pg_dump` + 对象存储 + 配置；`.env`（含 `LITELLM_SALT_KEY`）不进备份；恢复用 `restore` 服务并需 `--yes-overwrite-database`；演练用 `scripts/restore-drill.sh`。

## 尚未验证

本骨架在没有 Docker 守护进程的环境里编写，只做了 `docker compose config` 解析校验；**整套栈尚未实际启动过**。首次在服务器上启动时需确认：LobeHub 2.2.20 在关闭 Agent Gateway 时的行为、`JWKS_KEY` 是否必填、各服务健康检查命令在镜像内可用、各档位内存上限是否够用。
