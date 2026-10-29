# 第三方组件与许可证（D112）

本表由 D112 要求维护；每个发布包须附各组件 LICENSE 与 NOTICE。许可证以各项目上游为准，下列为实现时的登记，发布前须逐项复核（待负责人确认）。

| 组件 | 版本（compose 固定） | 许可证（登记） | 用途 / 说明 | 替代品 | 替换成本 |
| --- | --- | --- | --- | --- | --- |
| LobeHub | 2.2.20 | LobeHub 社区许可证 | 对话与协作界面（D189）。只以官方镜像原样运行：不 fork、不改源码、不注入任何代码（D190），不进任何依赖树，因此不受 CI 许可证闸门扫描；所有者已接受保留 LobeHub 品牌、零授权费（2026-10-29） | Open WebUI（D181–D188）→ 自建（D178） | 中：只经 /v1、MCP、Core /api 接入，界面层可整体换 |
| lobehub-gateway | 0.3.2 | 以上游为准 | 待复核 | | LobeHub 配套 | 随界面更换 | 随界面 |
| LiteLLM | v1.106.4 | MIT（企业目录除外） | 仅用开源部分 | | 模型适配器（Core 只认 OpenAI 格式） | 直连各厂商 OpenAI 兼容端点 / 其他网关 | 低：只在模型适配器内 |
| ParadeDB | 0.26.3-pg17 | AGPL-3.0（pg_search）/ PostgreSQL | 以服务方式使用 | | 数据库（标准 SQL + 迁移文件） | 普通 PostgreSQL | 低：专有特性须包在适配器内 |
| Redis | 7.4.12 | RSALv2 / SSPL（7.4 起） | 见下方评估 | | 缓存/队列 | Valkey（BSD-3） | 低：协议兼容，换镜像 |
| RustFS | 1.0.4 | Apache-2.0 | | | 对象存储（S3 协议） | MinIO / R2 / 任意 S3 | 低：配置项 |
| cloudflared | 2026.10.5 | Apache-2.0 | | | 隧道 | 其他反向代理/隧道 | 低 |

## CI 许可证闸门（D179）

- CI 任务「许可证闸门」：`scripts/license-gate/check-npm.mjs` 扫描仓库内所有 package-lock.json（含 devDependencies），`scripts/license-gate/check-python.sh` 对每个 requirements*.txt 建临时 venv 用 pip-licenses 检查。
- AGPL、SSPL、BUSL、Commons Clause、Elastic、RSAL、PolyForm、非商用（NC）、带品牌限制（如 LobeHub 社区许可证）直接失败，不能登记例外。
- 白名单外的其他许可证（GPL、自定义、缺失）失败，须在 `scripts/license-gate/allow.json` 逐包登记许可证原文与可商用理由后才放行。
- 闸门只管进入我们依赖树、会被构建进镜像或安装包的代码；以官方镜像原样运行的独立服务（LobeHub、ParadeDB、Redis 等）在本表登记，不经闸门。

## Redis 换 Valkey 评估

- 现状：compose 使用 redis:7.4.12-alpine，仅作缓存/队列，命令集为基础命令，启动参数 `--save 60 1000 --appendonly yes`。
- 方案：换成 Valkey（BSD-3-Clause，Redis 7.2 分支，协议兼容）。`valkey-cli ping`、AOF/RDB 参数相同，数据目录 `/data` 可直接沿用。
- 风险：LobeHub 是否用到 7.4 之后的专有模块——登记为未发现，需在 AWS 上换镜像后跑一遍真实对话验证。
- 结论：建议换，作为独立小 PR（改镜像与 healthcheck 命令，部署到 AWS 验证后合并）。待负责人确认。


## 不部署的组件（D157–D172，方案第 8 节）

Karakeep、RSSHub、MetaMCP、ContextForge、Mastra、agent-browser、noVNC、Mem0/OpenMemory、Langfuse、本地 embedding、LibreChat RAG/Meilisearch 均不部署，已从本表移除；如日后启用须先补许可证、用途、替代品与替换成本。

第三方 SDK 只允许出现在各自 adapters/ 目录。
