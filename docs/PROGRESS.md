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
| v4.3 裁决入档（D30–D61）、讨论模式、KEY-STORAGE、SEQUENCES | 主程序员 | 🟡 待审查 | docs/v4.3 → dev | Muse 1–15 清单与负责人裁决表待补充 |
| 方案反对式评审 | 验收员（Muse） | ✅（据 v4.3 裁决，Muse 意见已裁决） | — | 原文未入仓库 |
| 开工前验证 docs/VERIFY.md（PRODUCT 第 20 节） | 主程序员 | ⏳ | | 与 P0 b 合并做 |

### P0 任务（顺序见 PRODUCT 16.1）

| # | 项 | 负责 | 状态 | 备注 |
|---|----|------|------|------|
| a | 仓库骨架、Docker Compose、CI | 主程序员 + Jules | 🟡 | 分支 p0/skeleton；可拆任务开 Issue 打 jules 标签 |
| a | 生成 ed25519 SSH 密钥，把公钥发给用户 | 主程序员 | ⏳/待确认 | 私钥不进仓库 |
| a | 经安全表单一次性要齐 P0 凭据（Cloudflare 限定令牌、测试模型 Key、AWS 之外的备份存储密钥） | 主程序员 | ⏳ | D60 |
| b | 服务器全模块部署 + 2 个浏览器任务 + 逐容器内存峰值 → 内存实测报告 → 定档位 + 长期主机建议 | 主程序员 | ⛔ 等服务器 IP | D40、D59 |
| c | 三张时序图 | 主程序员 | 🟡 待审查 | docs/architecture/SEQUENCES.md |
| d | Cloudflare Tunnel + Access；只开 22；仅密钥登录；fail2ban | 主程序员 | ⛔ 等服务器、Cloudflare 令牌 | D57 |
| e | AWS 之外备份 + 恢复演练（记录耗时） | 主程序员 | ⛔ 等备份存储凭据 | D49；KEY-STORAGE 2.3 |
| f | 本地完整版（Windows 一键安装包等） | 主程序员 | ⛔ 等用户电脑配置 | D56 f |
| — | Key 加密存储方案 | 主程序员 | 🟡 待审查 | docs/architecture/KEY-STORAGE.md |

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
