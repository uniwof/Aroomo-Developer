# 第三方组件与许可证（D112）

本表由 D112 要求维护；每个发布包须附各组件 LICENSE 与 NOTICE。许可证以各项目上游为准，下列为实现时的登记，发布前须逐项复核（待负责人确认）。

| 组件 | 版本（compose 固定） | 许可证（登记） | 说明 |
| --- | --- | --- | --- |
| LobeHub | 2.2.20 | LobeHub 社区许可证 | 分发衍生作品需商业授权；所有者已知情（D112） |
| lobehub-gateway | 0.3.2 | 以上游为准 | 待复核 |
| LiteLLM | v1.106.4 | MIT（企业目录除外） | 仅用开源部分 |
| ParadeDB | 0.26.3-pg17 | AGPL-3.0（pg_search）/ PostgreSQL | 以服务方式使用 |
| Redis | 7.4.12 | RSALv2 / SSPL（7.4 起） | 见下方评估 |
| RustFS | 1.0.4 | Apache-2.0 | |
| cloudflared | 2026.10.5 | Apache-2.0 | |
| Karakeep | 计划（D118） | AGPL-3.0 | 以服务方式使用 |

## Redis 换 Valkey 评估

- 现状：compose 使用 redis:7.4.12-alpine，仅作缓存/队列，命令集为基础命令，启动参数 `--save 60 1000 --appendonly yes`。
- 方案：换成 Valkey（BSD-3-Clause，Redis 7.2 分支，协议兼容）。`valkey-cli ping`、AOF/RDB 参数相同，数据目录 `/data` 可直接沿用。
- 风险：LobeHub 是否用到 7.4 之后的专有模块——登记为未发现，需在 AWS 上换镜像后跑一遍真实对话验证。
- 结论：建议换，作为独立小 PR（改镜像与 healthcheck 命令，部署到 AWS 验证后合并）。待负责人确认。
