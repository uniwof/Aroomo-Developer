# /work 项目与版本 v1（一页设计）

对应 Poke 验收清单第 10 项（Work 显示项目状态、不可变版本、产物、审核状态，链接打开确切对象）和第 1 项的 /work 部分。审计 `behavior-audit-2026-11-05` §7。上一版 `design-poke-data-v1.md` 把它列为「需 Core API」。

## 需求卡
1. 目标：所有者在 /work 看到自己项目的真实进展——每个项目有哪些版本、谁产出的、审到哪一步、产物在哪——数据只来自真实信号，没有就空着。
2. 验收：① /work 直接打开、刷新、前进后退都对，项目列表四态（加载/空/错/有）；② 版本只由来源同步产生，内容写入后不可改（库层拒绝 UPDATE 内容列）；③ 审核状态 草稿/审核中/要修改/已通过/已发布 显式写出，「已发布」只由来源确认（GitHub 非草稿 release），点「通过」不等于发布；④ 点项目/版本/产物打开那一个（`/work/<项目>`、`/work/<项目>?v=<版本 id>`），产物打不开时说一句 + 重试；⑤ 跨账号读不到、改不了（RLS + 反向测试）。
3. 边界：必做——每条查询带 user_id、RLS、字段只加不改、出站请求只到固定主机；先问——私有仓库（要 Key 进保险箱）、定时自动同步、Webhook、项目删除；永不——编造版本/状态/进度、上传或付费存储、令牌进界面/日志/模型（D199）。
4. 假设：项目由所有者自己建（名字是她起的，这是真实数据）；「下一个里程碑」v1 没有来源，界面不显示这一栏（不写「无」以外的东西）；家人账号各管各的，不共享项目。
5. 测试：core `vitest`（memory + pglite 迁移 up/down/up、RLS 跨账号反向、GitHub 用假 fetch）；console `vitest` + Playwright 假数据截图 390/1280；对话页包 ≤150 kB（/work 单独懒加载块，不进对话页包）。

## 数据从哪来（只用真实信号）
| 来源 | 版本 = | 审核状态 | 产物 |
|---|---|---|---|
| GitHub 公开仓库（所有者填 `owner/repo`） | 每个 release（含 tag 名、作者、发布时间）；没 release 的仓库用 tag | 草稿 release = 草稿；已发布 release = 已发布（来源确认） | release 页链接 + 附件（文件名、大小、下载链接，GitHub 给的原值） |
| Aroomo 自己 | 就是一个 GitHub 来源（本仓库），用 `scripts/release-tag.sh` 打的标签 | 同上 | 同上 |
| 公共记忆（已有 `public_memory_versions`） | 某主题的每个版本 | 草稿，所有者可改审核状态 | 打开该主题该版本；源版本被清理后显示「这个版本已被清理」 |
| 助手运行（已有 `assistant_runs`，status=succeeded） | 一次成功运行的结果摘要 | 草稿，所有者可改 | 打开那段对话（`message_ids`） |
没有手填版本、没有上传。私有仓库要 GitHub 令牌放保险箱，是新凭据流程，v1 不做（先问所有者）。

## 表（迁移 0033_work，带 down；三张都开 RLS，策略同 design-rls-v1）
- `work_projects`：id uuid、user_id、name（1–80 字，同账号未删除唯一）、status（active/paused/done，所有者设）、sources jsonb（≤5 个：`{type:'github',repo}` / `{type:'memory',topic}` / `{type:'assistant',assistantId}`）、created_at、updated_at、deleted_at。
- `work_versions`：id uuid、user_id、project_id、source_type、source_ref（release id / topic@version / run id）、label（v1.2.0 等）、title、actor jsonb `{type,name,id?}`、artifacts jsonb（≤20：type、title、url?、size?）、source_published bool、created_at（来源时间）、synced_at。唯一 (project_id, source_type, source_ref) = 同步幂等键。触发器拒绝 UPDATE 这些列（不可变快照：来源后来改了也不覆盖，下一次同步只加新版本）。
- `work_reviews`：只追加。version_id、user_id、status（draft/in_review/changes_requested/approved）、note ≤500、actor、at。当前审核 = 最后一行；`已发布` 不在这里，由 `source_published` 给出。

## 接口（Core，全部 owner/成员令牌，带 user_id；列表分页）
- `GET /api/work/projects?cursor=` → 名字、状态、来源、更新时间、最新版本（label + 审核状态）、参与者（版本 actor 去重）。
- `POST /api/work/projects` {name, sources?}；`PATCH /api/work/projects/:id` {name?, status?, sources?}。来源校验：repo 符合 `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`；topic、assistant 必须属于本账号。
- `POST /api/work/projects/:id/sync` → 拉来源，新版本插入（唯一键冲突 = 已有，跳过），回 `{added, unchanged, failed:[{source, reason}]}`；同项目进行中再调回 409。GitHub 只请求 `https://api.github.com/repos/<repo>/releases|tags`（固定主机、不跟重定向、5 秒超时、每页 30 条），无令牌，回 403/429 就报「GitHub 限流，稍后再试」。
- `GET /api/work/projects/:id/versions?cursor=&review=` → 时间线（新在前）；`GET /api/work/versions/:id` → 单个版本 + 审核记录。
- `POST /api/work/versions/:id/review` {status, note?, idempotencyKey} → 追加一行；同键同内容返回原结果，同键不同内容 409。
- 审计：建项目、改来源、同步、审核各记一条（不记 note 原文以外的东西，不记令牌——v1 本来就没有令牌）。

## /work 界面（web/console，单独懒加载块）
- `/work`：项目列表（名字、状态、最新版本 + 审核状态文字、参与者、更新时间），按状态筛；空状态一句 +「添加项目」；错误一句 +「重试」。
- `/work/<id>`：版本时间线（label、标题、产出者、时间、审核状态、产物数）+「同步」（处理中锁住，结果读屏播报：新加 N 个 / 失败原因）。
- `/work/<id>?v=<版本 id>`：版本详情，产物列表（类型、标题、大小、打开）；审核状态改动走全站确认弹窗；「已发布」只读。
- 外观照现有组件，不加新样式、不加动画；驾驶舱「进行中」指标卡改跳 /work（有数据时）。

## 仍然「需 Core API / 先问」
私有仓库与令牌、自动定时同步与 Webhook、下一个里程碑（GitHub milestones 可作为 v2 来源）、项目删除（破坏性，单独确认）、家人间共享项目、产物上传。

## 切片（每片先写失败测试，草稿 PR）
1. 迁移 0033 + 项目增改查 + GitHub 公开 release 同步 + `/work`、`/work/<id>` 只读（列表、时间线、产物链接）。A+（迁移、RLS、出站请求）。
2. 审核状态（work_reviews + 确认弹窗 + 幂等键）。
3. 公共记忆、助手运行两个来源。
4. 驾驶舱指标卡接 /work。
