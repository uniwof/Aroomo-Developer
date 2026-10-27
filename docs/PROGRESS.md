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
| b | 服务器全模块部署 + 2 个浏览器任务 + 逐容器内存峰值 → 内存实测报告 → 定档位 + 长期主机建议 | 主程序员 | ⛔ 等服务器 IP | D40、D59 |
| c | 三张时序图 | 主程序员 | 🟡 待审查 | docs/architecture/SEQUENCES.md |
| d | Cloudflare Tunnel + Access；只开 22；仅密钥登录；fail2ban | 主程序员 | ⛔ 等服务器、Cloudflare 令牌 | D57 |
| e | AWS 之外备份 + 恢复演练（记录耗时） | 主程序员 | 🟡 脚本与 CI 端到端测试已合并（#17）；真实环境演练 ⛔ 等服务器与备份存储凭据 | D49；KEY-STORAGE 2.3；docs/ops/BACKUP.md |
| f | 本地完整版（Windows 一键安装包等） | 主程序员 | ⛔ 等用户电脑配置 | D56 f |
| — | Key 加密存储方案 | 主程序员 | 🟡 待审查 | docs/architecture/KEY-STORAGE.md |

### P0 Core 模块（2026-10-27，主程序员 Hark；顺序按依赖）

| Issue | 模块 | 状态 | PR | 说明 |
|-------|------|------|----|------|
| #11 | 只追加审计日志 + Core 数据库 / 迁移 / 鉴权白名单骨架 | ✅ 已合并到 dev | #18 | `core/src/audit`、`db`、`auth`；迁移 0001；触发器禁止 UPDATE/DELETE/TRUNCATE；D36 白名单 |
| #5 | 成员管理 API（增删改、排序、置顶、回收站 30 天） | ✅ 已合并到 dev | #20 | `core/src/members`；迁移 0002；彻底删除需 confirm |
| #7 | 收件箱数据模型 + API（不可逆动作二次确认） | ✅ 已合并到 dev | #22 | `core/src/inbox`、`confirm`；迁移 0003；只执行一次（CAS）、一次性确认令牌 5 分钟 |
| #6 | Key 管理 API（写入 LiteLLM，Key 永不返回客户端） | ✅ 已合并到 dev | #24 | `core/src/keys`；迁移 0004（表里没有存 Key 的列）；泄露测试 |
| #8 | 点名解析与执行（D31） | 🟡 PR 已提交（p0/mention-parser） | p0/mention-parser | 引号名、代码/URL 排除、Unicode 索引、120 秒超时 + AbortSignal、delegateFromHint、敏感项目不发外部成员 |

- 存储：有 `CORE_DATABASE_URL` 用 PostgreSQL（启动自动迁移），否则内存（只适合开发 / 演示）。测试：PGlite 每次跑 + CI 的 PostgreSQL 17 服务容器再跑一遍。
- 访问：`/api/*` 需要 `Authorization: Bearer <CORE_OWNER_TOKEN>`（P0 单用户）；未配置时一律 503。
- 尚未接入：前端（LobeHub 界面）调用这些 API、对话真正经 LiteLLM 调模型、定时任务（回收站清理、确认令牌清理、Key 对账）。

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

## 阻塞

| 阻塞项 | 卡住什么 | 需要谁 |
|--------|----------|--------|
| 服务器 IP（AWS 法兰克福 m7i-flex.large） | P0 b、d、e | 用户（先收到 SSH 公钥） |
| P0 凭据（Cloudflare 限定令牌、测试模型 Key、备份存储密钥） | P0 b、d、e | 用户（安全表单） |
| 用户电脑配置（Windows 版本、内存、剩余硬盘，裁决消息中为空白） | P0 f | 用户 |
| PR #1、#2 未合并到 main（2026-10-27 22:57 经 GitHub API 核实为 open） | main 与 dev 不一致；不影响在 dev 上工作 | 用户 |
| Muse 1–15 清单与负责人裁决表 | D39 细节 | 用户转达 |

## 变更
- 2026-10-27：建立本文件。
- 2026-10-27：完成旧项目审计（docs/AUDIT.md）。
- 2026-10-27：负责人 v4.3 裁决入档（D30–D61）；P0 开始；新增 KEY-STORAGE.md、SEQUENCES.md。
- 2026-10-27：Core 模块：审计日志（#18）、成员（#20）、收件箱（#22）合并到 dev；Key 管理（#24）合并到 dev；点名解析（#8）PR 提交。Jules 对 #11/#5/#6/#8 的重复 PR（#13/#15/#16/#14）已留言建议关闭。
