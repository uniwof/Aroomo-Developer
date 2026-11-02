# Staging（staging.pcmanai.com）

> 工单 #170 / D209。dev 每次合并后自动部署到 staging；各线不再手动登服务器部署。生产只部署 main 上打标签的版本（#171）。

## 一句话

- 地址：<https://staging.pcmanai.com>（Cloudflare Access 后面，只允许所有者邮箱，邮箱验证码登录，会话 30 天；Access 应用「Aroomo staging」，策略与生产「Aroomo app」共用「Aroomo owner only」）。
- 部署：服务器 systemd timer 每 2 分钟查一次 `origin/dev`，有新提交就跑 `deploy/staging/deploy-staging.sh`。合并后一般 **2–5 分钟**内上线。
- 回滚：新提交构建失败或健康检查超时，脚本自动回到上一个部署成功的提交，并记下失败的提交（同一提交不会反复重试，修好再合一个新提交即可）。

## 怎么查 staging 现在是哪个提交

任选一种：

1. 服务器上（只读）：
   ```bash
   /opt/aroomo-staging/deploy/staging/deploy-staging.sh status
   # 或
   cat /opt/aroomo-staging/.deploy/current
   tail -n 20 /opt/aroomo-staging/.deploy/history.log
   ```
2. 看容器标签：
   ```bash
   docker inspect aroomo-staging-core-1 --format '{{index .Config.Labels "org.aroomo.commit"}}'
   ```
3. 看部署日志：`journalctl -u aroomo-staging-deploy.service -n 50`。
4. Actions Secrets 到位后，`deploy-staging` 工作流最后一步会打印 `status`（当前提交 + 容器状态）。

`current` 等于 `git rev-parse origin/dev` 就说明已是最新。

## 和生产怎么隔离

| 项 | 生产 | staging |
|----|------|---------|
| 目录 | `/opt/aroomo` | `/opt/aroomo-staging`（独立克隆，只跟 dev） |
| compose 项目 | `aroomo` | `aroomo-staging`（`-f deploy/docker-compose.yml -f deploy/staging/compose.staging.yml`） |
| 数据卷 / 网络 | `aroomo_*` | `aroomo-staging_*`（互不共用） |
| .env | `/opt/aroomo/deploy/.env` | `/opt/aroomo-staging/deploy/.env`（600，`init-env.sh` 在服务器上现场生成，不出服务器、不进仓库） |
| Core / Shell 镜像 | `aroomo-core:dev`、`aroomo-shell:dev` | `aroomo-core:staging`、`aroomo-shell:staging` |
| 对外 | Tunnel `aroomo-app`：app.pcmanai.com → `http://shell:3000` | 同一 Tunnel：staging.pcmanai.com → `http://aroomo-staging-shell:3000` |

- staging 不发布任何宿主机端口。为了让生产的 cloudflared 能找到 staging Shell，部署脚本在每次 `up` 之后执行
  `docker network connect --alias aroomo-staging-shell aroomo_aroomo <staging shell 容器>`：只加这一个别名，**不带服务名 `shell`**，
  所以生产的 `shell` 解析不受影响；staging Shell 的上游也改用 staging 独有的别名（`aroomo-staging-lobe`、`aroomo-staging-core`）。
- 内存：每个容器都有 `mem_limit`，并全部放进 systemd 切片 `aroomo-staging.slice`（MemoryHigh 1100M / MemoryMax 1400M）。
  部署前可用内存低于 350 MB 就跳过本轮，绝不和生产抢内存。

## staging 起了哪些服务

postgres、redis、rustfs（+ rustfs-init）、core、lobe、shell。

**没有起 litellm**：4 GB 机器上生产已用约 2 GB，litellm 常驻 0.6–0.8 GB 装不下。所以 staging 里**不能真正对话**（发消息会报上游不可用）；
登录、控制台（/console）、各页面、成员/Key/收件箱等不依赖模型调用的功能都能测。等换更大的机器或生产减负后，
在 `compose.staging.yml` 把 litellm 加回 `deploy-staging.sh` 的 `SERVICES` 即可。

## 小号

`core/src/seed/xiaohao.ts`（D205）需要 `XIAOHAO_EMAIL` / `XIAOHAO_PASSWORD`，只放 staging 的 `.env`。这两个值由所有者提供，放进 `.env` 后：

```bash
cd /opt/aroomo-staging
docker compose -p aroomo-staging --project-directory deploy --env-file deploy/.env \
  -f deploy/docker-compose.yml -f deploy/staging/compose.staging.yml \
  run --rm -e XIAOHAO_EMAIL -e XIAOHAO_PASSWORD -e XIAOHAO_ALLOW_PRODUCTION=1 core node dist/seed/xiaohao.js
```

（Core 镜像固定 `NODE_ENV=production`，所以 staging 里要加 `XIAOHAO_ALLOW_PRODUCTION=1`；这是 staging 自己的库，不是生产。）

## 文件

| 文件 | 作用 |
|------|------|
| `deploy/staging/compose.staging.yml` | compose 覆盖：mem_limit、切片、只依赖必要服务、staging 专用别名 |
| `deploy/staging/deploy-staging.sh` | fetch → reset 到 origin/dev → 构建 → up -d → 接入 cloudflared 网络 → 健康检查 → 失败回滚；`status` 看状态 |
| `deploy/staging/init-env.sh` | 在服务器上生成 staging `.env`（只补缺的键，不打印值） |
| `deploy/staging/aroomo-staging.slice` | staging 总内存上限 |
| `deploy/staging/aroomo-staging-deploy.{service,timer}` | 每 2 分钟拉取部署 |
| `.github/workflows/deploy-staging.yml` | dev push 后经部署专用 SSH 密钥触发同一脚本；缺 Secrets 时跳过 |

## 第一次安装（服务器，已于 2026-11-01 完成）

```bash
sudo git clone -b dev https://github.com/uniwof/Aroomo-Developer.git /opt/aroomo-staging
sudo chown -R ubuntu:ubuntu /opt/aroomo-staging
/opt/aroomo-staging/deploy/staging/init-env.sh <Access 应用 Aroomo staging 的 AUD>
sudo cp /opt/aroomo-staging/deploy/staging/aroomo-staging.slice \
        /opt/aroomo-staging/deploy/staging/aroomo-staging-deploy.service \
        /opt/aroomo-staging/deploy/staging/aroomo-staging-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
/opt/aroomo-staging/deploy/staging/deploy-staging.sh --force
sudo systemctl enable --now aroomo-staging-deploy.timer
```

仓库是公开的，服务器用 https 只读拉取，不放任何 GitHub 令牌。

## 切回 Actions 推送式部署

服务器上已有一把只能运行部署脚本的 SSH 密钥（`authorized_keys` 里 `command="/opt/aroomo-staging/deploy/staging/deploy-staging.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`），
私钥只在 Hark 工作区。需要主会话派浏览器把它存为仓库 Actions Secret `STAGING_SSH_KEY`，另存 `STAGING_HOST`、`STAGING_KNOWN_HOSTS`。
存好后 `deploy-staging` 工作流自动生效；timer 可以保留做兜底（脚本有锁，不会重复部署）。

## 验收记录

- 2026-11-01：合并本说明的一次小文档 PR 作为验收提交，由服务器 timer 自动拉取部署（不手动触发），结果与耗时记录在工单 #170 评论。
