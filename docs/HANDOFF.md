# Aroomo 交接（HANDOFF.md）

> 任何接手者只读 docs/PRODUCT.md、docs/PROGRESS.md 和本文件就能继续工作（PRODUCT 17.2.3 第 5 条）。
> 在 Core 的自动交接包（I3）实现前由执行者手动维护（见 DECISIONS D28）。
> 最后更新：2026-10-27，主程序员（Hark）。

## 1. 一句话现状
P0（MVP）已开始。负责人 v4.3 裁决已入档为 D30–D61（其中 D31 = 讨论模式），PRODUCT.md 已按裁决加修订注；Key 存储方案和三张时序图已写好待审。仓库骨架 / Compose / CI 在 p0/skeleton 分支进行中。尚无服务器、尚无线上部署。

## 2. 必读
1. docs/PRODUCT.md（优先级 v4.3 ＞ v4.2 ＞ v4.1 ＞ v4；P0 范围见 16.1；讨论模式见 9.4.1；改动清单见文末「附录：v4.3 修订记录」）
2. docs/DECISIONS.md（D30–D61 为 v4.3 裁决；D27–D28 仍为提议）
3. docs/PROGRESS.md
4. docs/architecture/KEY-STORAGE.md、docs/architecture/SEQUENCES.md
5. docs/AUDIT.md（第 5 节 P1–P20 的处理见 DECISIONS 第五节末表）

## 3. 仓库与环境
- 仓库：github.com/uniwof/Aroomo-Developer（D30）。
- 分支：`main`（只在阶段验收后由用户合并）← `dev`（CI 通过后主程序员可合并，D53）← `docs/*`、`p{期号}/{模块}`、`fix/*`。CI 尚未建立，在此之前所有 PR 都不自行合并。
- 旧仓库 uniwof/Aroomo（用户告知已改私有）与旧站 chat.pcmanai.com：冻结，不得触碰、不得重新部署（D30）。
- 服务器（待建）：AWS 法兰克福 m7i-flex.large，Ubuntu 24.04，60 GB，固定 IP，用户名 ubuntu；只开 22，仅密钥登录，fail2ban；对外经 Cloudflare Tunnel + Access（D57、D58）。主程序员不持有 AWS 凭据。额度约 $80/月，用到一半前交迁移方案（D59）。

## 4. 进行中 / 下一步
1. 等审查：PR「docs: v4.3 裁决（D30–D31）、讨论模式、Key 存储与时序图」（docs/v4.3 → dev）。
2. P0 a：仓库骨架、Docker Compose、CI（p0/skeleton）；可拆任务开 Issue 打 jules 标签。
3. 生成 ed25519 SSH 密钥并把公钥发给用户（若尚未完成）；经安全表单一次性要齐 P0 凭据（D60）。
4. 拿到服务器后：全模块部署 → 内存实测报告 → 定档位（D40）；Cloudflare 接入；AWS 之外备份 + 恢复演练。
5. 最后：Windows 本地完整版（需要用户电脑配置）。
6. 沟通：每天日报 ≤5 行，末行「需要你做」（D61）。用户 48 小时未回复：不卡脖子的继续，卡脖子的暂停并记录（D54）。

## 5. 阻塞 / 未决问题
- 服务器 IP 未到；P0 凭据未交付；用户电脑配置（Windows 版本、内存、剩余硬盘）未填。
- PR #1、#2 仍为 open、未合并到 main（2026-10-27 经 GitHub API 核实；用户消息中说已合并，两者不一致，需用户确认）。
- Muse 1–15 清单与负责人裁决表未提供：D36–D39、D46、D50 的细节标为待补充。
- 新系统域名未定（旧站域名已冻结，D30/D57）；值班哨兵排期未定（不在 P0 MVP）。
- 负责人换人的默认超时、点名时同一成员多来源之间是否允许回退：待负责人确认（SEQUENCES.md）。
- D27、D28 仍待负责人确认。

## 6. 凭据
不在仓库中记录任何凭据。凭据由用户通过安全表单直接交付（PRODUCT 0.4、17.2.3 第 6 条、D60）。LITELLM_SALT_KEY 只放服务器 .env，备份用用户保管的恢复密钥（KEY-STORAGE.md）。
