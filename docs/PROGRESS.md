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
| v4.3 裁决入档（D30–D61）、讨论模式、KEY-STORAGE、SEQUENCES | 主程序员 | ✅ 已合并到 dev（#3，2026-10-27） | docs/v4.3 → dev | Muse 1–15 原文与裁决表已于 2026-10-28 补齐（DECISIONS 第 7.5 节） |
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
| d | Cloudflare Tunnel + Access；只开 22；仅密钥登录；fail2ban | 主程序员 | ✅ 2026-10-28：只开 22（安全组 + ufw）、仅密钥登录、禁 root、fail2ban、自动安全更新、4 GB swap；Tunnel `aroomo-app` → app.pcmanai.com → `http://shell:3000`（2026-10-28 由 `lobe:3210` 改指 Shell）；Access 只允许用户本人邮箱（邮箱一次性验证码，会话 30 天，D67） | D57、D66、D67 |
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
| 界面 | 品牌第二轮：上游文字 Logo、逐字动画标题、匿名数据开关行 | ✅ 已合并到 dev | #37 | |
| 界面 | 品牌第三轮：主人设计的 Logo（侧栏、登录页、正在准备页、favicon、PWA 全尺寸、Apple 图标、默认助理头像）；主题色珊瑚色 #ff7f50（D69 薄层覆盖主色变量，填充上用深色字）；苹果式简洁动效（只用 CSS，遵守减少动态效果）；共用素材 assets/brand（独立版图标 / 托盘 / 启动页） | 🔄 PR | 本 PR | CI 界面冒烟 theme.json |
| 界面 + Core | Aroomo 页面接 Core（成员 / Key 与接入 / 收件箱 / 设置 + 确认卡）、D73、负责人、填 Key 自动建成员；提议 H3/H4 | ✅ 已合并到 dev | #38 | |
| 对话 | LobeHub → Core /v1（D31 点名 / 交给负责人）→ LiteLLM；界面冒烟用假模型验证「填 Key 后能对话」；提议 H5 | ✅ 已合并到 dev | #39 | 含 `/v1/responses` 转换（LobeHub 开联网 / 智能搜索时走 Responses API）；P0 不转发工具（web_search / 函数工具） |
| Core | 定时任务：回收站 30 天彻底删除（6 小时）、过期确认清理（1 小时）、Key 与 LiteLLM 对账（1 小时，缺失只提醒一次） | ✅ 已合并到 dev | #40 | `CORE_JOBS=off` 可关；结果写审计 `job.run` |

- 存储：有 `CORE_DATABASE_URL` 用 PostgreSQL（启动自动迁移），否则内存（只适合开发 / 演示）。测试：PGlite 每次跑 + CI 的 PostgreSQL 17 服务容器再跑一遍。
- 访问：`/api/*` 需要 `Authorization: Bearer <CORE_OWNER_TOKEN>`（P0 单用户）；未配置时一律 503。
- 界面入口：浏览器 → Aroomo Shell（`shell/`，H1）→ 官方 LobeHub；Aroomo 页面在 `/aroomo/*`，`/aroomo/api/*` 同源转发 Core。
- 对话入口：LobeHub 的 OpenAI 服务商指向 `http://core:8080/v1`（令牌 `CORE_CHAT_TOKEN`），模型名 `aroomo`。

### P0 验收标准

- [ ] 手机和电脑都能登录
- [ ] 新界面填入一个 Key 后能和模型对话
- [ ] 恢复演练成功
- [ ] 内存实测报告完成
- [ ] Muse 评审通过
- [ ] 本地版在用户电脑上能跑起来

## 负责人 P0 审查（2026-10-28）

- 负责人判定：P0 约 70%（代码约 85%，验收 0/6），P1 约 30%，总体约 14%。逐条见 DECISIONS 第 7.5 节来源文件第二部分。
- 主程序员补充（同日）：真实对话已跑通（Groq 测试 Key 经 Core → LiteLLM，自动选出负责人）；2 路并发长回复内存峰值 lobe 约 730 MiB、litellm 约 777 MiB，未用 swap。上传场景未测。
- 负责人下一步 5 件事：① 用户一次交付测试 Key + R2 + 限桶令牌（已完成）；② 统一主密钥并做两次真实恢复演练；③ 真实对话 + 2 并发内存（部分完成）；④ 独立版在用户电脑实装（先修 Host 白名单 ✅ PR #50、主密钥分叉）；⑤ 文档清账（D79–D101 已入档，PRODUCT 7.3/7.5/7.6、third-party.md、VERIFY.md、HANDOFF 待做）。

## 待确认依赖表（2026-10-29，D157–D172 影响判断）

| 待答 | 受影响模块 | 返工范围 | 当前处理 |
|---|---|---|---|
| Q1 界面 | 界面层（B4 后定 LibreChat 或 assistant-ui） | 仅界面层；Core 走 /v1、MCP、/api | 照常做 Core，不写死界面 |
| Q2 甲骨文 | 部署配置、A3 恢复演练、第 1b 步 | 仅部署配置 | 代码全做；A3/1b 待所有者答 Q2 |
| Q3 外部工具账号 | 各工具适配器 | 仅对应适配器 | 网关、manifest、额度框架先做 |
| Q4 模型 Key | 模型配置 | 仅配置 | 路由、aroomo/auto 先做，默认按负责人建议 |
| Q5 本机执行员 | CLI 智能体适配器、白名单默认值 | 仅这两处 | 任务队列、协议、接管卡先做 |

## 执行员需要的 API（执行员线登记，交后台线实现；2026-10-29）

合同：[docs/executor-protocol.md](executor-protocol.md)；执行员客户端在 `executor/`，现用 `executor/test/mock-core.ts` 模拟测试。Core 端实现时以合同为准，有分歧先改合同。

| 需要 | 说明 | 状态 |
|---|---|---|
| 客户端令牌新 scope：`tasks:pull`、`tasks:secret` | D162；令牌归属 user_id，只能领 / 取本用户的任务与凭据（越权测试） | ✅ 已在 dev |
| 执行员令牌同时可授 `models:chat`（已有 scope） | 执行员的模型规划器经 Core /v1/chat/completions 规划网页操作（默认模型 aroomo/auto）；只发脱敏后的快照与字段名，不发凭据值 | 已有 scope，需在控制台「本机执行员」生成令牌时默认勾上 |
| 任务队列表 + MCP `create_task` / `get_task`（给 LobeHub 负责人用） | 任务类型 checkin / login / signup / browse；字段见合同 3.1；定时触发用 pg-boss（D173） | ✅ 已在 dev |
| `POST /api/executor/hello` | 上线登记，返回 executorId、pollWaitSec、leaseSec；控制台据此显示「电脑在线 / 离线」 | ✅ 已在 dev |
| `POST /api/executor/tasks/claim`（长轮询 ≤30 秒） | 一个任务只能领一次；租约 600 秒，过期退回队列（D162） | ✅ 已在 dev |
| `POST /api/executor/tasks/:id/progress` | 进度 + 心跳续租；响应带 `cancel` | ✅ 已在 dev |
| `POST /api/executor/tasks/:id/takeover`、`GET …/takeover/:tid`（长轮询） | 推接管卡到收件箱（captcha / 2fa / payment / login_failed / not_allowed），计入打扰预算 D100；等待期间租约冻结 | ✅ 已在 dev；接管卡同时进收件箱（kind executor.takeover，「我处理好了」「取消这个任务」），任务页处理后自动收卡 |
| `POST /api/executor/tasks/:id/secret` | 按任务声明的 secretId + field 从保险箱取值；未声明返回 422 SECRET_NOT_DECLARED；每次审计 | ✅ 已在 dev |
| `POST /api/executor/tasks/:id/result` | 结束任务，幂等；租约已收回返回 409 LEASE_LOST | ✅ 已在 dev |
| Core `/mcp` 工具 `create_task` / `get_task` / `list_tasks` / `cancel_task`（包一层 `/api/tasks`，同令牌隔离；同 kind+site+当天去重） | 工具定义与 LobeHub 定时任务写法见 [executor-schedule.md](executor-schedule.md)；`POST /api/tasks` 已在 dev，MCP 层待后台线（V4 依赖） | ✅ 已在 dev |
| 服务器端站点白名单（派任务前校验） | 已实现（PR p1/server-allowlist）：`GET/PUT /api/executor-allowlist`（{sites:[域名或 android-app://包名]}，空=不限制）；创建任务不命中返回 403 SITE_NOT_ALLOWED；hello 的 `allowlistHash` 出现在 `GET /api/executors` | 已做 |

## 分期总览（2026-10-28 起按 DECISIONS D114 / 第 7.6 节第三部分）

总原则：先把服务器网页版做扎实，所有工作都在服务器上验证；离线版等「网页版完工」（D114）。在此之前独立版只修阻塞性 bug，CI 照常构建，不发新包。

### 阶段 A：P0 收尾（现在 → P0 验收）
| 序号 | 事项 | 谁 | 完成标准 | 状态 |
|------|------|----|----------|------|
| A1 | 一次交付：测试模型 Key、R2 桶和只限该桶的令牌 | 所有者（安全表单） | Hark 确认收到 | 🟡 测试 Key、R2 令牌已在保管库，待确认 R2 令牌只限该桶 |
| A2 | 生成全系统唯一的主密钥（age-keygen 最小工具），公钥发给 Hark | 所有者 + Hark | 服务器 BACKUP_AGE_RECIPIENT 已填 | ✅ 2026-10-28 20:30 主密钥由独立版首次启动生成（DPAPI 保护），公钥已填服务器 `deploy/.env`（改前已备份） |
| A3 | 启用服务器备份；在另一台全新机器上恢复演练（同时验证迁移，D116-6） | Hark | 记录耗时，客户端零改动 | ⛔ 服务器 `BACKUP_S3_*` 仍空：R2 令牌在 Hark 保管库，按规则不能经过沙盒/仓库送到服务器，需所有者用安全方式填入（见「需要你做」）；先在 CI 临时环境用本地 S3 做备份与恢复演练（`backup-e2e` 已有） |
| A4 | 真实对话端到端；补测 2 个并发对话内存；LiteLLM 真实联调 | Hark | 验收第 2、4 条打勾 | 🟡 Core→LiteLLM→Groq 已通（约 0.7 秒）；2 路并发长回复实测（2026-10-28，standard 档，t4g.medium 4 GB）：lobe 峰值约 730 MiB、litellm 约 777 MiB，未用 swap，未超 mem_limit（各 1 GiB）；空闲（20:55）lobe 590 MiB、litellm 665 MiB、全栈约 1.5 GiB。Groq 免费额度会限流。网页 UI 端到端（浏览器里发消息收到回复）未完成：自动化浏览器访问 /aroomo/* 会卡住，待查 |
| A5 | P0-f：所有者把 app.pcmanai.com「安装为应用」并正常使用 | 所有者 + Hark | 验收第 1、6 条打勾 | 🟡 2026-10-28 20:33 所有者已在 Chrome 把 app.pcmanai.com 安装为应用；「正常使用」待网页端到端（A4）完成后一并验收 |
| A6 | Muse 评审 P0 | Muse | 验收第 5 条打勾 | ⏳ |
| A7 | 文档清账：DECISIONS 入档；PRODUCT 7.3/7.5/7.6；third-party.md；VERIFY.md；HANDOFF 过期行 | Hark | 审查清单第 4、6 项通过 | 🟡 D111–D117 已入档 |

### 阶段 B：P1 + 多用户（P0 验收后）
（按 D118 重排）B1 Better Auth 邀请制登录 + user_id 隔离 + 越权测试 → B2 保险箱 + 工具网关 → B3 MCP 只读 + 客户端令牌/吊销 → B4 OpenAI 兼容接口 + 成员分别露出（LiteLLM 别名）→ B5 MCP 调工具（确认、限额）→ B6 公共记忆与交接包 → B7 旧站数据迁移。D31 审查/辩论/并行对比取消；热度雷达、网页代办、大部分后台员工移到「观察」。状态：⏳（B1 进行中：**B1a 账号底座**已在 PR p1/b1-users-auth——Core 层邮箱+密码登录、凭邀请注册、退出本设备/所有设备、改密码、管理员重置链接与停用、登录限速、审计、账号默认不能访问任何业务接口；**B1b 业务表 user_id 隔离 + 越权测试**逐模块进行（成员、负责人设置已隔离，分支 p1/b1b-members-tenancy；收件箱 / Key 记录 / 确认令牌 / 审计查询未做——收件箱的动作处理器目前是所有者全局的，隔离时必须让处理器带 user_id，否则账号可借自己发的卡片触发所有者的动作）；**B3 底座**（外部客户端令牌：范围白名单、吊销即时生效、限速、全量审计，客户端默认不能访问任何业务接口）分支 p1/b3-client-tokens；B2–B6 设计合同见 docs/architecture/HUB.md。**实现注（待负责人确认）：** D117-15 写「用 LobeHub 自带 Better Auth」，所有者 2026-10-29 要求界面可能更换，登录放在 Core/网关层不绑任何界面，故 B1a 用 Core 自带账号表；以后若仍用 LobeHub，可作为一种登录方式接到同一个 users 表。）

### 阶段 C：长期主机与迁移（D59：AWS 额度用到一半之前）
C1 长期主机方案（按 5 个活跃用户估算规格和月费，付费由所有者拍板）→ C2 用 scripts/migrate.sh 真实迁移一次（客户端零改动）。状态：⏳

**A、B、C 都完成 = 网页版完工（D114）。**

### 阶段 D：离线版（网页版完工后）
D1 轻量桌面程序（Tauri 2，≤ 30 MB，版本握手，服务器地址可改）→ D2 离线核心三层包 + 签名清单 + R2 下载域名 → D3 首次运行进 CI（PowerShell 5.1、端口保留、工作组账户名）→ D4 D79 单向恢复按用户隔离 → D5 所有者电脑验收 → 删除 installer/windows → 一键卸载 Docker 和 WSL（D106）。状态：⏳

P2–P7 的功能开发在阶段 C 之后照常在网页版上推进，离线版跟随同一份代码。

## 服务器（2026-10-28）

- AWS EC2 **t4g.medium（ARM64/Graviton）**，**us-east-2 俄亥俄**，2 vCPU / 3.7 GiB + 4 GB swap，Ubuntu 24.04，58 GB。原计划的法兰克福 m7i-flex.large 已由负责人 D66 改为此机（不再换更大的机器；完整版内存以后在用户电脑上实测）。
- 代码在 `/opt/aroomo`（dev），`AROOMO_TIER=standard`，`COMPOSE_PROFILES=tunnel`（backup 等 R2）。服务器 `.env` 只在服务器上（chmod 600），含 `LITELLM_SALT_KEY` 等，**用户需离线另存一份**。
- 访问：https://app.pcmanai.com（Cloudflare Access 团队 `aroomo.cloudflareaccess.com`）。
- 2026-10-28 13:24（北京时间）更新到 dev `f349d90`（#38–#40）：新增 `CORE_CHAT_TOKEN`；`KEY_VAULTS_SECRET` 原为 64 位十六进制（base64 解码 48 字节，LobeHub 拒绝），已改为 `openssl rand -base64 32`（旧值从未成功加密过数据；改前的 .env 备份在服务器 `deploy/.env.bak-*`）。8 个容器健康（cloudflared 无健康检查，Tunnel 状态 healthy、4 条连接），未登录访问 302 到 Access 登录页；空闲内存约 1.8 GiB 已用 / 3.7 GiB，swap 0。

## 控制台需要的 API（控制台线登记，交后台线实现；2026-10-29）

控制台 web/console 由 Core 在 /console 提供静态文件（D195），只调用 Core /api。已有可用：POST /auth/login、/auth/accept，GET /api/auth/me，POST /api/auth/logout，/api/members*，/api/keys*，/api/inbox*，/api/confirm/*，/api/clients*，/api/vault*，/api/memory*，/api/settings/*，/api/users*，/api/audit。

| 需要 | 用在哪页 | 说明 | 状态 |
|---|---|---|---|
| 控制台会话 Cookie：POST /auth/login、/auth/accept 带 `cookie:true` → 令牌只放 HttpOnly + SameSite=Strict（https 时加 Secure）的 aroomo_session Cookie，响应里不再有 token；/api 在没有 Bearer 时认该 Cookie（只认账号会话），改动类请求（POST/PUT/PATCH/DELETE）必须带 `X-Aroomo-Request: 1` 头否则 403 CSRF；/api/auth/logout、logout-all 会清 Cookie | 登录 | A 类，已提 PR p1/session-cookie（待负责人审）；控制台改用时 fetch 带 credentials:'same-origin' 和该头 |
| GET /api/capabilities?kind=&access=（能力清单第一版：items 文本/生图/视频 + counts + summary「文本 N · 生图 N · 视频 N」；每项 access=free/trial/paid、status=ready/unverified/failed/missing/keyless、quota{used,limit,unit}、quotaKnown=false 显示「未知」；tools 为算力/沙盒/云手机等；library 技能 148/资源 45 分组计数） | 能力地图与成员 | D157–D172 第 2 步 / M1 | ✅ PR p1/capabilities-api（种子来自资源清单，不含 Key；实时额度待后续） |
| PUT /api/capabilities/:id/trial {endsAt:"2026-12-31"\|null}（填试用到期日；GET /api/capabilities 的 items/tools 多 trialEndsAt、trialDaysLeft；≤3 天或已过期每 6 小时检查并发收件箱提醒） | 能力地图（试用徽标旁显示剩余天数 + 到期日输入） | M4 | ✅ PR p1/trial-expiry |
| /v1 模型别名（LobeHub 群组同步用）：`aroomo/auto` = 负责人入口（@成员 则该成员答，不 @ 负责人答，与 `aroomo` 同义）；`aroomo/<成员id>` = 直接由该成员答（不解析 @、不署名；名字空格换 - 也认）；`GET /v1/models` 列出这些别名 | LobeHub 群组：负责人智能体用 aroomo/auto，每个成员智能体用 aroomo/<成员id> | M1 第 3 项 | ✅ PR p1/lead-routing |
| /api/library 资源库最小版：POST（只给 url 也行；同链接去重；像密码/Key 的内容拒收）、GET ?q=&kind=&limit=（关键词检索，多词都要命中，标题>标签>链接>正文）、GET/:id、DELETE/:id（仅本人）。客户端范围 library:read / library:write（MCP submit_resource 用 write）。检索先 ILIKE，接口后可换 PGroonga | 资源库页（丢链接+搜索） | M2 | ✅ PR p1/library |
| GET /api/tools、工具开关与额度 | 工具 | 工具网关 | 待后台线 |
| GET /api/library（资源库列表、搜索） | 资源库 | | 待后台线 |
| GET /api/inbox?type=confirm\|takeover\|brief（可与 group/status 组合；confirm = 含重要确认动作的卡） | 收件箱 | 接管卡、简报分类 | ✅ PR p1/inbox-type |
| GET /api/executors、任务队列只读列表 | 本机执行员 | | 待后台线 |
| GET /api/usage（额度圆环：每位在职成员 today{requests,errors,limited}、last7DaysRequests、tokensToday（供应商返回过用量才有数字，非流式回答；否则 null=未知）、quota{used,limit,unit:"次/天"}、quotaKnown、ratio、state=unknown/ok/warn/full/limited；total）；PUT /api/usage/limits/:memberId {dailyLimit:整数\|null}（所有者自己填每天次数上限，没填=未知） | 顶栏/成员头像圆环（D7） | Core 自己数经 /v1 的调用（北京时间按天，只记次数）；账号用户 tracked=false | ✅ PR p1/usage |
| GET /api/mcp/config（按当前用户生成 MCP 连接配置，不含明文令牌，令牌另走一次性显示） | 设置 | D195 MCP 配置复制 | 已做（PR 待合并）|
| GET /api/members 每位成员多 online（布尔：在职 + 启用 + 未删除 + 有一把状态正常的 Key 对着它） | 成员头像彩色 / 黑白（D7） | 只在列表接口带；其他接口不带 | ✅ PR p1/member-online |
| GET/PUT /api/settings/security、GET /api/audit 对 owner/admin 账号开放（现在只认所有者令牌，账号登录会 403） | 设置 → 安全 | 控制台用账号登录 | 待后台线 |

## 两个账号与隔离（隔离线约定；D205、D206；2026-10-31 起）

- **小号 seed 由隔离线负责**：`core/src/users/seed.ts`（幂等函数 `seedXiaohao`）+ CLI `node dist/seed/xiaohao.js`。凭据只经环境变量 `XIAOHAO_EMAIL`、`XIAOHAO_PASSWORD` 注入（staging 的 .env 或保险箱），不进仓库/日志；`NODE_ENV=production` 时默认拒绝。staging 部署后由控制台线在 compose 里跑一次：`docker compose exec core node dist/seed/xiaohao.js`（可重复跑）。
- **测试夹具（各线复用）**：`core/test/helpers/two-accounts.ts`——`twoAccounts(env)` 返回所有者 `owner(...)` 与小号 `xiao(...)` 两个调用器；`twoAccountEnvs` 覆盖 memory / PGlite / CI PostgreSQL。断言：`expectHidden`（403/404 或不含所有者标记）、`expectDenied`（改删必须 403/404）、`expectSameAsMissing`（所有者 id 与不存在 id 结果一致，看不出存在）、`expectEmptyList`（列表/计数为空）。
- **完成定义**：每个新功能 PR 至少加一条用 `twoAccounts` 的用例：小号看不到、改不了、看不出存在；小号自己的同一功能可用。
- **RLS（D206）**：按模块逐个开（A+，每模块一个 PR，等负责人审）；按用户开事务的助手接口届时在本节登记。

## 阻塞

| 阻塞项 | 卡住什么 | 需要谁 |
|--------|----------|--------|
| R2 备份桶 + 只限该桶的令牌（D72） | P0 e | 用户（Cloudflare 控制台） |
| 测试模型 Key | P0 b 真实对话负载、验收「能和模型对话」（CI 已用假模型验证整条链路） | 用户（安全表单） |
| Windows 安装器生成的 `KEY_VAULTS_SECRET` 是 64 位十六进制（`New-AroomoSecret`），LobeHub 要求 base64 解码后 16/24/32 字节 | 本地版 LobeHub 设置加密报错 | 主程序员（与单机版安装器任务协调后修） |
| 本地测试版在用户电脑上的第一次真实安装（Windows 版本、内存、剩余硬盘仍未知） | P0 f 验收 | 用户 |
| 主密钥公钥（用户在电脑上生成后发来 `age1…`） | 服务器备份（D64/D65 共用主密钥） | 用户 |
| D64 实现注 a/b、D65 实现注 a、「新增 Key 也算涉及凭据」 | 确认实现方向 | 负责人 |
| PR #1、#2 未合并到 main（2026-10-27 22:57 经 GitHub API 核实为 open） | main 与 dev 不一致；不影响在 dev 上工作 | 用户 |
| Muse 1–15 清单与负责人裁决表 | D39 细节 | 用户转达 |

## 变更
- 2026-10-28：#38 Aroomo 页面接 Core、#39 对话经 Core /v1 → LiteLLM（含 Responses API 转换、冒烟修复）、#40 Core 定时任务合并到 dev；服务器更新到 `f349d90`，Tunnel 改指 `shell:3000`。
- 2026-10-28：#33 修复 AGENT_GATEWAY_URL 空值 + D66–D75 入档；#36 Aroomo Shell 界面薄层 + D76–D80 入档、提议 H1/H2。
- 2026-10-28：负责人裁决 D62–D65 入档（#26）并实现：操作员白名单 + 统一确认服务（#27）、备份公钥加密（#28）、安装器主密钥窗口与电脑版备份（#29）、测试版发布流程（#30）。
- 2026-10-27：建立本文件。
- 2026-10-27：完成旧项目审计（docs/AUDIT.md）。
- 2026-10-27：负责人 v4.3 裁决入档（D30–D61）；P0 开始；新增 KEY-STORAGE.md、SEQUENCES.md。
- 2026-10-27：Core 模块：审计日志（#18）、成员（#20）、收件箱（#22）合并到 dev；Key 管理（#24）合并到 dev；点名解析（#8）PR 提交。Jules 对 #11/#5/#6/#8 的重复 PR（#13/#15/#16/#14）已留言建议关闭。
