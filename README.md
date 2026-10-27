# Aroomo

一家 24 小时在线的「AI 公司」的管理系统（自用）。需求以 [docs/PRODUCT.md](docs/PRODUCT.md) 为准。

## 目录

| 路径 | 内容 |
|------|------|
| `docs/` | 产品文档、决策日志、进度、交接、审计 |
| `core/` | Aroomo Core（TypeScript / Node 22 / Fastify）：路由、成员与 Key 管理、收件箱等 |
| `deploy/` | Docker Compose（服务器与 Windows 本地版共用一套）、部署档位、各服务配置 |
| `scripts/` | 档位选择、compose 封装、备份 / 恢复（restic） |

## 快速开始（本机）

```bash
cp deploy/.env.example deploy/.env      # 填写占位值，不要提交 .env
AROOMO_LOCAL=1 scripts/compose.sh up -d # 自动按内存选档位，打开 http://localhost:3210
```

服务器部署、档位、备份与恢复见 [deploy/README.md](deploy/README.md)。

## 开发规则

- 一切改动走 PR：分支 `docs/*`、`p{期号}/{模块}`、`fix/*`；CI 通过后合并到 `dev`，`main` 只在阶段验收后合并（PRODUCT §17.2.3）。
- 密钥、令牌、密码不得出现在仓库、PR、Issue、日志里。
