# Aroomo 交接（HANDOFF.md）

> 任何接手者只读 docs/PRODUCT.md、docs/PROGRESS.md 和本文件就能继续工作（PRODUCT 17.2.3 第 5 条）。
> 在 Core 的自动交接包（I3）实现前由执行者手动维护（见 DECISIONS D28）。
> 最后更新：2026-10-28，主程序员（Hark）。

## 1. 一句话现状
P0（MVP）进行中。dev 上已有：仓库骨架 / Compose / CI（#4）、v4.3 裁决文档（#3）、Core 的审计日志（#18）、成员（#20）、收件箱（#22）、Key 管理（#24）、点名解析（#25）、Windows 安装器（#23）；2026-10-28 负责人裁决 D62–D65 已入档（#26）并实现：操作员白名单 + 统一确认服务（#27）、备份改为主密钥公钥加密（#28）、安装器主密钥窗口 + 电脑版备份（#29）、测试版发布流程（#30，预发布 `local-test`）。Core 有 HTTP API 和 PostgreSQL 存储，但还没有前端接入、还没真正经 LiteLLM 调模型。尚无服务器、尚无线上部署；Windows 测试版尚未在真实电脑上跑过。

## 2. 必读
1. docs/PRODUCT.md（优先级 v4.3 ＞ v4.2 ＞ v4.1 ＞ v4；P0 范围见 16.1；讨论模式见 9.4.1；改动清单见文末「附录：v4.3 修订记录」）
2. docs/DECISIONS.md（D30–D61 为 v4.3 裁决；D62–D65 为 2026-10-28 裁决，含待确认的实现注；D27–D28 仍为提议）
3. docs/PROGRESS.md
4. docs/architecture/KEY-STORAGE.md、docs/architecture/SEQUENCES.md、docs/architecture/CONFIRM-CARD.md；docs/ops/BACKUP.md、docs/ops/WINDOWS.md
5. docs/AUDIT.md（第 5 节 P1–P20 的处理见 DECISIONS 第五节末表）

## 3. 仓库与环境
- 仓库：github.com/uniwof/Aroomo-Developer（D30）。
- 分支：`main`（只在阶段验收后由用户合并）← `dev`（CI 通过后主程序员可合并，D53）← `docs/*`、`p{期号}/{模块}`、`fix/*`。CI 尚未建立，在此之前所有 PR 都不自行合并。
- 旧仓库 uniwof/Aroomo（用户告知已改私有）与旧站 chat.pcmanai.com：冻结，不得触碰、不得重新部署（D30）。
- 服务器（待建）：AWS 法兰克福 m7i-flex.large，Ubuntu 24.04，60 GB，固定 IP，用户名 ubuntu；只开 22，仅密钥登录，fail2ban；对外经 Cloudflare Tunnel + Access（D57、D58）。主程序员不持有 AWS 凭据。额度约 $80/月，用到一半前交迁移方案（D59）。

## 4. 进行中 / 下一步
1. Core 代码地图（`core/src/`）：`db/`（pg 连接池 + 迁移器，迁移在 `core/migrations/NNNN_*.sql`，合并后只增不改）、`auth/`（主人令牌 `CORE_OWNER_TOKEN`、操作员令牌只存 HMAC；`capabilities.ts` = D62 白名单 + 禁止清单；每个路由用 `guard(cap)` 声明能力，操作员调用未声明 / 不在白名单的接口一律 403 + 审计）、`audit/`（只追加；`req.audit(action, target, result, note?)`）、`members/`、`inbox/`（含 `POST /api/inbox` 发卡片）、`confirm/`（**统一确认服务，D63**：`ConfirmService.require(spec, confirmCtx(...), audit)`，普通直接放行，重要 → 428 challenge → `/api/confirm/:id/steps` 两步 + 3 秒 + 凭据操作 Access 重新验证 → 一次性令牌；新增需要确认的操作一律用它，不要另造确认方式）、`keys/`（LiteLLM 管理 API；完整 Key 只在 LiteLLM）、`router/`（D31 点名 / 交给负责人）。依赖装配在 `deps.ts`，路由注册在 `server.ts`。
2. 测试约定：每个存储都有内存 + PostgreSQL 实现，跑同一套契约测试（`test/helpers/db.ts`：PGlite 总是跑，设置 `CORE_TEST_DATABASE_URL` 时再跑真 PG；CI 已配 postgres:17 服务容器）。测试里的假密钥在运行时拼接（避免 gitleaks 误报），前缀 `placeholder-`。
3. 下一步（Core）：对话链路——LobeHub 发一句话 → Core 路由（`route()` / `executeMentionPlan()`）→ LiteLLM，见 SEQUENCES.md「发一句话」；前端接入成员 / Key / 收件箱 API；定时任务（回收站 30 天清理、确认令牌清理、LiteLLM 部署对账）；操作员令牌签发 / 吊销与落库（负责人体系）。
4. 生成 ed25519 SSH 密钥并把公钥发给用户（若尚未完成）；经安全表单一次性要齐 P0 凭据（D60）。
5. 拿到服务器后：全模块部署 → 内存实测报告 → 定档位（D40）；Cloudflare Tunnel + Access（同时配 `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`，否则凭据操作 503）；填用户发来的主密钥公钥 `BACKUP_AGE_RECIPIENT` + 备份存储凭据 → AWS 之外备份 + 真实恢复演练（需要用户临时输入主密钥）；对真实 LiteLLM v1.106.4 联调 Key 管理（见 #24「未验证事项」）。
6. Windows 本地版：测试版在预发布 `local-test`（`.github/workflows/release-local-test.yml`，dev 上 installer/ 改动自动重发）。等用户在真实电脑上装一次，按反馈修。
7. 沟通：每天日报 ≤5 行，末行「需要你做」（D61）。用户 48 小时未回复：不卡脖子的继续，卡脖子的暂停并记录（D54）。

## 5. 阻塞 / 未决问题
- 服务器 IP 未到；P0 凭据未交付；主密钥公钥未到（用户装测试版时生成）；用户电脑配置（Windows 版本、内存、剩余硬盘）未填。
- PR #1、#2 仍为 open、未合并到 main（2026-10-27 经 GitHub API 核实；用户消息中说已合并，两者不一致，需用户确认）。
- Muse 1–15 清单与负责人裁决表未提供：D36–D39、D46、D50 的细节标为待补充。
- 值班哨兵排期未定（不在 P0 MVP）。
- Jules 对 #11/#5/#6/#8 已开了重复 PR（#13/#15/#16/#14），已留言建议关闭；需要用户（或 Jules）关闭，**不要合并**，否则会覆盖 dev 上的实现。
- 已由 D62/D63 解决：操作员白名单按 D62 列出（`inbox:read`/`inbox:act` 已移出）；`confirm: true` 和收件箱一次性令牌已统一为确认服务。
- 待负责人确认（DECISIONS D64/D65 实现注）：a. 备份改用 age 公钥加密、`.env` 进加密包；b. 主密钥由安装程序在用户电脑上离线生成并用窗口显示（代替「安全表单下发」）；D65-a. Windows 关机前备份靠「Aroomo 停止」+ 登录后补备份；另：「新增 / 替换 Key 也算涉及凭据」。
- 负责人换人的默认超时、点名时同一成员多来源之间是否允许回退：待负责人确认（SEQUENCES.md）。
- D27、D28 仍待负责人确认。

## 6. 凭据
不在仓库中记录任何凭据。凭据由用户通过安全表单直接交付（PRODUCT 0.4、17.2.3 第 6 条、D60）。LITELLM_SALT_KEY 只放服务器 .env，备份用用户保管的恢复密钥（KEY-STORAGE.md）。
