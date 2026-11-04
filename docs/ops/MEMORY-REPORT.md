# 内存实测报告（P0-b，标准版）

> 2026-10-28，主程序员（Hark）。依据 D40、D59、D66。完整版（full）的内存以后在用户电脑上实测（D66），本报告只覆盖标准版。

## 1. 结论

- **服务器定为标准版（standard）**：AWS t4g.medium（ARM64，2 vCPU，3.7 GiB 内存 + 4 GB swap）能跑全部 P0 模块。实测全栈常驻约 **1.9–2.0 GiB**，剩余约 1.8 GiB 可用，**全程没用到 swap、没有 OOM、没有重启**。
- **LiteLLM 是最大的单个容器**，空闲就约 620 MiB（Python + Prisma），cgroup 峰值顶到旧上限 768 MiB。标准版上限改为 **1024m**。
- LobeHub 2.2.20 常驻 420–590 MiB，cgroup 峰值 726 MiB，1024m 上限够用，但**真实对话（流式回复、文件解析）还没测**，见第 5 节。
- PostgreSQL（ParadeDB）匿名内存很小，cgroup 峰值 363 MiB 主要是页缓存；上限从 768m 降为 640m。
- 按 D66，每个容器都加了 `mem_limit`（含一次性的 `rustfs-init`、`restore`），CI（`scripts/check-compose.sh`）会检查三个档位都没有遗漏。
- **对话演示版（demo-2g）有风险**：它给 LiteLLM 的上限是 512m，低于 LiteLLM 空闲时的实测用量（约 575 MiB 匿名内存）。2 GB 机器上很可能反复 OOM。未在 2 GB 机器上实测，建议负责人决定：demo-2g 是否去掉 LiteLLM、或改为 3 GB 起步。

## 2. 环境

| 项 | 值 |
|----|----|
| 主机 | AWS EC2 t4g.medium，us-east-2（俄亥俄），ARM64（Graviton） |
| 系统 | Ubuntu 24.04.5 LTS，内核 7.0.0-1014-aws，cgroup v2 |
| 内存 | 3.7 GiB（MemTotal 3824 MiB）+ 4 GB swap 文件（vm.swappiness=10） |
| Docker | Docker Engine + compose 插件 v5.6.1 |
| 代码 | dev @ 016c883 |
| 档位 | `AROOMO_TIER=standard`（旧上限：postgres 768m、redis 128m、rustfs 256m、litellm 768m、core 256m、lobe 1024m、cloudflared 128m） |
| 运行的容器 | postgres、redis、rustfs、rustfs-init（一次性）、litellm、core、lobe、cloudflared（profile `tunnel`） |
| 未运行 | backup（缺 R2 凭据和主密钥公钥，D72）、gateway（profile 未开） |

所有镜像都有 linux/arm64（2026-10-28 在镜像仓库核对 manifest，并在服务器上 `docker image inspect` 确认 Architecture=arm64）：lobehub/lobehub:2.2.20、paradedb/paradedb:0.26.3-pg17、redis:7.4.12-alpine、rustfs/rustfs:1.0.4、rustfs/rc:v0.1.36、ghcr.io/berriai/litellm:v1.106.4、cloudflare/cloudflared:2026.10.5、ghcr.io/lobehub/lobehub-gateway:0.3.2、node:22.23.4-alpine3.24（core 构建）、postgres:17.11-alpine3.24（backup 构建）。core 镜像在服务器上本机构建（arm64），无需 CI 交叉构建。

## 3. 方法

1. `docker stats --no-stream` 每轮约 4 秒采样一次（命令本身耗时约 2 秒 + 间隔 2 秒），同时记录 `free -m` 的主机已用内存和 swap。共约 550 秒。
2. 结束时读取每个容器的 cgroup v2 `memory.peak`（容器启动以来的真实峰值，**含页缓存**）和 `memory.stat` 里的 `anon`（进程自己的内存）。
3. 阶段：启动（容器刚起来，采样晚于 `up` 约 1 分钟开始）→ 空闲 → 负载 → 空闲 → 负载 → 空闲。
4. 负载（「2 个浏览器任务」的近似）：在 Compose 网络里起一个 curl 容器，**2 个并发「用户」各循环 180 秒**，每轮：打开 `/signin`、`/signup` 单页应用外壳 → 下载页面引用的全部 JS/CSS → 查询会话 `/api/auth/get-session` → 用不存在的邮箱提交一次登录（被拒绝，走数据库查询）。两个用户共完成约 2360 轮（约 13 轮/秒）。

**没测到的**：真正的对话（发消息 → LiteLLM → 模型流式回复）。原因：服务器上还没有测试用的模型 Key（P0 凭据未交付），而且 Access 只允许用户本人邮箱，自动化浏览器无法登录。第一次负载曾误跟随跳转到 Cloudflare Access，那一轮只当空闲参考，不计入负载结论。

## 4. 结果

### 4.1 每个容器的峰值

| 容器 | 空闲 avg | 负载 avg | `docker stats` 峰值 | cgroup `memory.peak`（含缓存） | 匿名内存（结束时） | 旧上限 | **新上限（standard）** |
|------|---------:|---------:|------:|------:|------:|------:|------:|
| postgres | 163 | 162–166 | 170 | 363 | 17 | 768m | **640m** |
| redis | 13 | 13 | 14 | 17 | 3 | 128m | 128m |
| rustfs | 60 | 63–64 | 66 | 147 | 53 | 256m | 256m |
| litellm | 618 | 618 | 646（启动） | **768（顶到上限）** | 575 | 768m | **1024m** |
| core | 29 | 30 | 31 | 46 | 22 | 256m | 256m |
| lobe | 423 | 525–537 | 589 | 726 | 525 | 1024m | 1024m |
| cloudflared | 17 | 16 | 18 | 18 | 14 | 128m | 128m |
| rustfs-init（一次性） | — | — | — | — | — | 无 | **64m** |
| backup / restore | 未运行 | | | | | 256m / 无 | 256m / **512m** |
| gateway | 未运行 | | | | | 128m | 128m |

单位 MiB。`docker stats` 的数值不含可回收的页缓存，cgroup 峰值含缓存，所以后者更大。

### 4.2 主机

| 阶段 | 主机已用（free -m） | swap |
|------|------:|-----:|
| 启动后 | 1732–1756 | 0 |
| 空闲 | 1764–1800 | 0 |
| 负载 | 1908–1986 | 0 |
| 结束 | 约 1960（另有约 2 GiB 页缓存，可用约 1.86 GiB） | 0 |

没有任何容器重启或被 OOM 杀掉（`RestartCount=0`、`OOMKilled=false`）。

## 5. 风险与后续

1. **真实对话的内存还没测。** 等用户给出测试模型 Key 后，在服务器上用本人账号登录做 2 个并发对话（含一次长回复和一次图片 / 文件上传），重新读 `memory.peak`。如果 lobe 超过 900 MiB 或 litellm 超过 900 MiB，再调上限。
2. **LiteLLM 常驻约 620 MiB**，是 4 GB 机器上最大的固定开销。若以后内存紧张，可评估 LiteLLM 关闭不需要的回调 / UI，或换更轻的网关（需要负责人裁决）。
3. **上限总和超过物理内存**（标准版常驻服务上限合计约 3.6 GiB，物理 3.7 GiB）。上限是天花板不是预留；实际常驻约 2 GiB，有 4 GB swap 兜底。但如果 lobe 和 litellm 同时顶到上限，会开始用 swap、变慢。
4. **demo-2g 的 LiteLLM 上限 512m 低于实测用量**（见第 1 节），需要负责人决定。
5. 采样每 4 秒一次，可能漏掉极短的尖峰；cgroup `memory.peak` 已弥补这一点（它记录的是真实最高值）。
6. 备份 sidecar 尚未运行（等 R2 凭据和主密钥公钥），它在备份时的内存（pg_dump + age + rclone）以后补测。

## 6. 长期主机建议（D59）

- 按 D66：**不换更大的机器**，服务器继续用 t4g.medium + 标准版。完整版只在用户电脑上跑，内存以后在用户电脑上实测。
- t4g.medium 按需价格约 $24/月（us-east-2，另加 60 GB gp3 约 $5/月），在 $80/月额度的一半以内。

## 7. 复现

```bash
# 服务器上（/opt/aroomo）
AROOMO_TIER=standard scripts/compose.sh up -d
# 每个容器的真实峰值（cgroup v2）
for c in $(docker ps -q); do id=$(docker inspect -f '{{.Id}}' $c); \
  echo "$(docker inspect -f '{{.Name}}' $c) $(( $(cat /sys/fs/cgroup/system.slice/docker-$id.scope/memory.peak)/1048576 ))MiB"; done
```
