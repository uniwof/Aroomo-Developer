# Aroomo 进度（PROGRESS.md）

> 每完成一项就更新（PRODUCT.md 第 17 节、17.2.3 第 5 条）。状态：✅ 完成 · 🟡 进行中 · ⏳ 未开始 · ⛔ 阻塞。

## 当前阶段：P0（MVP）已开始（2026-10-27，负责人 v4.3 裁决 D56）

P0 范围与验收见 PRODUCT 16.1。分支规则：CI 通过后主程序员可合并到 dev；dev→main 只在阶段验收后由用户点（D53）。

### 准备期收尾

| 项 | 负责 | 状态 | 产出 / PR | 备注 |
|----|------|------|-----------|------|
| 文档转换：三份 Word → docs/PRODUCT.md | 主程序员（Hark） | 🟡 PR #1 未合并到 main | docs/spec | 内容已进入 dev |
| 建立 DECISIONS / PROGRESS / HANDOFF | 主程序员 | 🟡 PR #1 未合并到 main | docs/spec | |
| 旧项目审计 docs/AUDIT.md | 主程序员 | 🟡 PR #2 未合并到 main | docs/audit | 内容已进入 dev |
| v4.3 裁决入档（D30–D61）、讨论模式、KEY-STORAGE、SEQUENCES | 主程序员 | ✅ 已合并到 dev（#3，2026-10-27） | docs/v4.3 → dev | Muse 1–15 清单与负责人裁决表待补充 |
| 方案反对式评审 | 验收员（Muse） | ✅（据 v4.3 裁决，Muse 意见已裁决） | — | 原文未入仓库 |
| 开工前验证 docs/VERIFY.md（PRODUCT 第 20 节） | 主程序员 | ⏳ | | 与 P0 b 合并做 |

### P0 任务（顺序见 PRODUCT 16.1）

| # | 项 | 负责 | 状态 | 备注 |
|---|----|------|------|------|
| a | 仓库骨架、Docker Compose、CI | 主程序员 + Jules | ✅ 已合并到 dev（#4） | Jules 任务 Issue #5–#11 |
| a | 生成 ed25519 SSH 密钥，把公钥发给用户 | 主程序员 | ⏳/待确认 | 私钥不进仓库 |
| a | 经安全表单一次性要齐 P0 凭据（Cloudflare 限定令牌、测试模型 Key、AWS 之外的备份存储密钥） | 主程序员 | ⏳ | D60 |
| b | 服务器全模块部署 + 2 个浏览器任务 + 逐容器内存峰值 → 内存实测报告 → 定档位 + 长期主机建议 | 主程序员 | 🟡 已部署标准版并完成空闲 + 2 并发页面负载实测（PR #34，docs/ops/MEMORY-REPORT.md）；**真实对话负载待测试模型 Key** | D40、D59、D66 |
| c | 三张时序图 | 主程序员 | 🟡 待审查 | docs/architecture/SEQUENCES.md |
| d | Cloudflare Tunnel + Access；只开 22；仅密钥登录；fail2ban | 主程序员 | ✅ 2026-10-28：只开 22（安全组 + ufw）、仅密钥登录、禁 root、fail2ban、自动安全更新、4 GB swap；Tunnel `aroomo-app` → app.pcmanai.com → `http://lobe:3210`；Access 只允许用户本人邮箱（邮箱一次性验证码，会话 30 天，D67） | D57、D66、D67 |
| e | AWS 之外备份 + 恢复演练（记录耗时） | 主程序员 | 🟡 改为主密钥公钥加密（age，D64）并通过 CI 端到端（#28）；真实环境演练 ⛔ 等 R2 桶 + 只限该桶的独立令牌（D72，现有 Cloudflare 令牌无 R2 权限，需用户在控制台创建）和主密钥公钥 | D49、D64、D65；KEY-STORAGE 2.3；docs/ops/BACKUP.md |
| f | 本地完整版（Windows 一键安装包等） | 主程序员 | 🟡 安装器已合并（#23）；D64 主密钥窗口 + D65 电脑版备份已合并（#29）；测试版发布到预发布 `local-test`（#30）；**尚未在真实电脑上跑过** | D56 f；docs/ops/WINDOWS.md |
| — | Key 加密存储方案 | 主程序员 | 🟡 待审查 | docs/architecture/KEY-STORAGE.md |

### P0 Core 模块（2026-10-27，主程序员 Hark；顺序按依赖）

| Issue | 模块 | 状态 | PR | 说明 |
|-------|------|------|----|------|
| #11 | 只追加审计日志 + Core 数据库 / 迁移 / 鉴权白名单骨架 | ✅ 已合并到 dev | #18 | `core/src/audit`、`db`、`auth`；迁移 0001；触发器禁止 UPDATE/DELETE/TRUNCATE；D36 白名单 |
| #5 | 成员管理 API（增删改、排序、置顶、回收站 30 天） | ✅ 已合并到 dev | #20 | `core/src/members`；迁移 0002；彻底删除需 confirm |
| #7 | 收件箱数据模型 + API（不可逆动作二次确认） | ✅ 已合并到 dev | #22 | `core/src/inbox`、`confirm`；迁移 0003；只执行一次（CAS）、一次性确认令牌 5 分钟 |
| #6 | Key 管理 API（写入 LiteLLM，Key 永不返回客户端） | ✅ 已合并到 dev | #24 | `core/src/keys`；迁移 0004（表里没有存 Key 的列）；泄露测试 |
| #8 | 点名解析与执行（D31） | ✅ 已合并到 dev | #25 | 引号名、代码/URL 排除、Unicode 索引、120 秒超时 + AbortSignal、delegateFromHint、敏感项目不发外部成员 |
| — | Windows 一键安装（PowerShell 安装器 + Inno Setup .exe + 启停/更新/备份快捷方式） | ✅ 已合并到 dev | #23 | installer/windows；D64/D65 改造见 #29 |
| D62 | 操作员白名单 / 禁止清单；白名单外请求拒绝并审计 | ✅ 已合并到 dev | #27 | `core/src/auth/capabilities.ts`；新增 `POST /api/inbox`（发卡片） |
| D63 | 统一确认服务（普通 / 重要两级；3 秒服务端强制；凭据操作重新验证 Cloudflare Access） | ✅ 已合并到 dev | #27 | `core/src/confirm/`；迁移 0005；前端约定 docs/architecture/CONFIRM-CARD.md |
| D64 | 备份改为主密钥公钥加密（age）；`.env` 进加密包 | ✅ 已合并到 dev | #28 | scripts/backup.sh、restore.sh；待负责人确认实现注 a |
| D64/D65 | 安装器：主密钥离线生成窗口；开机后 / 停止前 / 更新前备份；本机 3 份；异地 pc/<电脑名> | ✅ 已合并到 dev | #29 | 待负责人确认实现注 b、D65 实现注 a |
| fix | AGENT_GATEWAY_URL 为空导致 LobeHub 崩溃（compose 默认 http://gateway:8787）+ D66–D75 入档 | ✅ 已合并到 dev | #33 | |
| 界面 | Aroomo Shell 界面薄层：品牌 Aroomo、按 §8 隐藏（FEATURE_FLAGS + 浏览器端）、朗读禁用（D68）、侧栏底部图标、PWA 清单（D77-2）、同源转发 Core；D76–D80 入档；提议 H1/H2 | ✅ 已合并到 dev | #36 | CI 界面冒烟（官方 LobeHub + Shell，电脑 + 手机截图）通过 |
| 界面 | 品牌第二轮：上游文字 Logo、逐字动画标题、匿名数据开关行；冒烟走完新用户引导并截对话页 | 🟡 | fix/shell-branding-2 | |

- 存储：有 `CORE_DATABASE_URL` 用 PostgreSQL（启动自动迁移），否则内存（只适合开发 / 演示）。测试：PGlite 每次跑 + CI 的 PostgreSQL 17 服务容器再跑一遍。
- 访问：`/api/*` 需要 `Authorization: Bearer <CORE_OWNER_TOKEN>`（P0 单用户）；未配置时一律 503。
- 界面入口：浏览器 → Aroomo Shell（`shell/`，H1）→ 官方 LobeHub；Aroomo 页面在 `/aroomo/*`，`/aroomo/api/*` 同源转发 Core。
- 尚未接入：Aroomo 页面调用 Core API（成员 / Key / 收件箱 + 确认卡 / 负责人）、对话经 Core 路由到 LiteLLM、定时任务（回收站清理、过期确认清理、Key 对账）。

### P0 验收标准

- [ ] 手机和电脑都能登录
- [ ] 新界面填入一个 Key 后能和模型对话
- [ ] 恢复演练成功
- [ ] 内存实测报告完成
- [ ] Muse 评审通过
- [ ] 本地版在用户电脑上能跑起来

## 分期总览（PRODUCT 第 16 节）

| 期 | 状态 |
|----|------|
| 准备 | 🟡 收尾（PR #1/#2 未合并到 main） |
| P0 | 🟡 已开始 |
| P1–P7 | ⏳（P1 加入 Key 迁移维护窗口和审查/辩论/并行对比） |

## 服务器（2026-10-28）

- AWS EC2 **t4g.medium（ARM64/Graviton）**，**us-east-2 俄亥俄**，2 vCPU / 3.7 GiB + 4 GB swap，Ubuntu 24.04，58 GB。原计划的法兰克福 m7i-flex.large 已由负责人 D66 改为此机（不再换更大的机器；完整版内存以后在用户电脑上实测）。
- 代码在 `/opt/aroomo`（dev），`AROOMO_TIER=standard`，`COMPOSE_PROFILES=tunnel`（backup 等 R2）。服务器 `.env` 只在服务器上（chmod 600），含 `LITELLM_SALT_KEY` 等，**用户需离线另存一份**。
- 访问：https://app.pcmanai.com（Cloudflare Access 团队 `aroomo.cloudflareaccess.com`）。

## 阻塞

| 阻塞项 | 卡住什么 | 需要谁 |
|--------|----------|--------|
| R2 备份桶 + 只限该桶的令牌（D72） | P0 e | 用户（Cloudflare 控制台） |
| 测试模型 Key | P0 b 真实对话负载、验收「能和模型对话」 | 用户（安全表单） |
| 本地测试版在用户电脑上的第一次真实安装（Windows 版本、内存、剩余硬盘仍未知） | P0 f 验收 | 用户 |
| 主密钥公钥（用户在电脑上生成后发来 `age1…`） | 服务器备份（D64/D65 共用主密钥） | 用户 |
| D64 实现注 a/b、D65 实现注 a、「新增 Key 也算涉及凭据」 | 确认实现方向 | 负责人 |
| PR #1、#2 未合并到 main（2026-10-27 22:57 经 GitHub API 核实为 open） | main 与 dev 不一致；不影响在 dev 上工作 | 用户 |
| Muse 1–15 清单与负责人裁决表 | D39 细节 | 用户转达 |

## 变更
- 2026-10-28：#33 修复 AGENT_GATEWAY_URL 空值 + D66–D75 入档；#36 Aroomo Shell 界面薄层 + D76–D80 入档、提议 H1/H2。
- 2026-10-28：负责人裁决 D62–D65 入档（#26）并实现：操作员白名单 + 统一确认服务（#27）、备份公钥加密（#28）、安装器主密钥窗口与电脑版备份（#29）、测试版发布流程（#30）。
- 2026-10-27：建立本文件。
- 2026-10-27：完成旧项目审计（docs/AUDIT.md）。
- 2026-10-27：负责人 v4.3 裁决入档（D30–D61）；P0 开始；新增 KEY-STORAGE.md、SEQUENCES.md。
- 2026-10-27：Core 模块：审计日志（#18）、成员（#20）、收件箱（#22）合并到 dev；Key 管理（#24）合并到 dev；点名解析（#8）PR 提交。Jules 对 #11/#5/#6/#8 的重复 PR（#13/#15/#16/#14）已留言建议关闭。
