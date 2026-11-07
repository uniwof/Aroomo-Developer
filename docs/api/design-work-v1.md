# /work 项目与版本 v1（一页设计）

对应 Poke 验收清单第 10 项（Work 显示项目状态、不可变版本、产物、审核状态，链接打开确切对象）和第 1 项的 /work 部分。审计 `behavior-audit-2026-11-05` §7。上一版 `design-poke-data-v1.md` 把它列为「需 Core API」。

## 需求卡
1. 目标：所有者在 /work 看到自己项目的真实进展——每个项目有哪些版本、谁产出的、审到哪一步、产物在哪——数据只来自真实信号，没有就空着。
2. 验收：① /work 直接打开、刷新、前进后退都对，项目列表四态（加载/空/错/有）；② 版本只由来源同步产生，内容写入后不可改（库层拒绝 UPDATE 内容列）；③ 来源状态（已发布 / 预发布 / 已打标签）和审核状态（草稿/审核中/要修改/已通过）分开写，「已发布」只由来源确认，点「通过」不等于发布；④ 点项目/版本/产物打开那一个（`/work/<项目>`、`/work/<项目>?v=<版本 id>`），产物打不开时说一句 + 重试；⑤ 跨账号读不到、改不了（RLS + 反向测试）。
3. 边界：必做——每条查询带 user_id、RLS、字段只加不改、出站请求只到固定主机；先问——私有仓库（要 Key 进保险箱）、定时自动同步、Webhook、项目删除；永不——编造版本/状态/进度、上传或付费存储、令牌进界面/日志/模型（D199）。
4. 假设：项目由所有者自己建（名字是她起的，这是真实数据）；「下一个里程碑」v1 没有来源，界面不显示这一栏；v1 只给所有者（Core 路由对家人账号 403，前端开关 `FLAGS.work` 默认 false，同批准 B）。
5. 测试：core `vitest`（memory + pglite 迁移 up/down/up、RLS 跨账号反向、GitHub 用假 fetch）；console `vitest` + Playwright 假数据截图 390/1280；对话页包 ≤150 kB（/work 单独懒加载块，不进对话页包）。

## 数据从哪来（只用真实信号）
| 来源 | 版本 = | 审核状态 | 产物 |
|---|---|---|---|
| GitHub 公开仓库（所有者填 `owner/repo`） | 每个**已发布**的 release（tag 名、作者、`published_at`）。草稿 release 不带令牌看不到，v1 不收。预发布（prerelease）照收，来源状态写「预发布」 | 来源状态：已发布 / 预发布（GitHub 给的，不可改）；审核按钮 v1 **不显示**（避免「已发布 + 要修改」打架），只读 | release 页链接 + 附件（文件名、大小 GitHub 原值）。链接同步时过滤（见下） |
| 同一仓库没有 release 时的 tag | 每个 tag 一个版本，来源状态「已打标签」（不算已发布）。tag 接口只给名字和提交号：**产出者、时间空着**，不拿提交时间冒充发布时间 | 同上，只读 | 只有「打开 GitHub」看这个 tag |
| Aroomo 自己 | 就是一个 GitHub 来源（本仓库），`scripts/release-tag.sh` 打的标签 | 同上 | 同上 |
| 公共记忆（已有 `public_memory_versions`） | 某主题的每个版本（含当前版）。标签「第 N 版」、标题 = 那一版的标题、时间 = 那一版写入的时间；没有作者 → 产出者空着。来源编号 `主题@版本号@写入毫秒`：删了再建的同名主题从第 1 版重新数，算新版本 | 审核从草稿开始，所有者可改（审核另一片做；切片 2 只读，不显示审核按钮） | 详情现读那一版正文；源版本被清理 / 主题删了显示「这个版本已被清理」 |
| 助手运行（已有 `assistant_runs`，status=succeeded） | 一次成功运行。标签 = 助手名字（同步那一刻的），标题 = 结果摘要第一行（没有摘要就空着），时间 = 完成时间，产出者 = 这个助手。一次同步看最近 100 次运行 | 同上 | 详情现读这次运行的完整摘要（运行删了说一句）+「打开助手」跳到那个助手的页面（v1 不定位到单条消息） |
没有手填版本、没有上传。私有仓库要 GitHub 令牌放保险箱，是新凭据流程，v1 不做（先问所有者）。

**产物链接过滤**（同步时，库里只存过滤后的）：只收 `https://`，主机限 `github.com` 和 GitHub 下载跳转用的 `objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`codeload.github.com`；带用户名密码、端口、别的主机一律丢掉（这条产物记「链接不可用」，不丢整版本）。界面上每个链接写「打开 GitHub ↗」并在新标签打开（`rel="noopener noreferrer"`），读屏名字带「离开 Aroomo」。

## 表（迁移 0033_work，带 down；三张都开 RLS，策略同 design-rls-v1）
- `work_projects`：id uuid、user_id、name（1–80 字，同账号未删除唯一）、status（active/paused/done，所有者设）、sources jsonb（≤5 个：`{type:'github',repo}` / `{type:'memory',topic}` / `{type:'assistant',assistantId}`）、created_at、updated_at、deleted_at。
- `work_versions`：id uuid、user_id、project_id、source_type、source_ref（release id / tag 名 / topic@version / run id）、label（v1.2.0 等）、title、actor jsonb NULL `{type,name,id?}`（拿不到就 NULL）、artifacts jsonb（≤20：type、title、url?、size?）、source_state（published / prerelease / tagged / none，none = 公共记忆、助手）、source_at timestamptz NULL（来源给的时间，tag 为 NULL）、synced_at。唯一 (project_id, source_type, source_ref) = 同步幂等键。触发器拒绝 UPDATE 这些列（不可变快照：来源后来改了也不覆盖，下一次同步只加新版本）。
- `work_reviews`：只追加。version_id、user_id、status（draft/in_review/changes_requested/approved）、note ≤500、actor、at。当前审核 = 最后一行；只对 source_state = none 的版本收（GitHub 来源回 409）；「已发布」不在这里，由 `source_state` 给出。
- **跟上已有的关**（同一个 PR）：三张表加进 `scripts/lib/rls-tables.txt`（precheck 检查 1）；`core/src/db/app-role.ts` 启动授权自动覆盖新表，`work_versions`、`work_reviews` 加进 `APPEND_ONLY_TABLES`（应用角色不能 DELETE，UPDATE 由触发器拒）；三张表 ENABLE + FORCE RLS，进 FORCE 自检（notForced 必须为空）；越权测试：A 账号读/改/同步/审核 B 的项目和版本全 404，家人账号调 /api/work/* 403。

## 接口（Core，全部 owner/成员令牌，带 user_id；列表分页）
- `GET /api/work/projects?cursor=` → 名字、状态、来源、更新时间、最新版本（label + 审核状态）、参与者（版本 actor 去重）。
- `POST /api/work/projects` {name, sources?}；`PATCH /api/work/projects/:id` {name?, status?, sources?}。来源校验：repo 符合 `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`；topic、assistant 必须属于本账号。
- `POST /api/work/projects/:id/sync` → 拉来源，新版本插入（唯一键冲突 = 已有，跳过），回 `{added, unchanged, failed:[{source, reason}]}`；同项目进行中再调回 409。GitHub 只请求 `https://api.github.com/repos/<repo>/releases|tags`（固定主机、不跟重定向、5 秒超时、每页 30 条、**最多 3 页**、响应体 ≤1 MB），无令牌。不带令牌每小时 60 次且按出口 IP 算（staging 和生产同机共用）：**每账号每项目 10 分钟最多同步一次**（再点回 429 + 还要等多久），GitHub 回 403/429 就报「GitHub 限流，稍后再试」并写出重置时间（响应头给的）。
- `GET /api/work/projects/:id/versions?cursor=&review=` → 时间线（新在前）；`GET /api/work/versions/:id` → 单个版本 + 审核记录。
- `POST /api/work/versions/:id/review` {status, note?, idempotencyKey} → 追加一行；同键同内容返回原结果，同键不同内容 409；GitHub 来源的版本 409（来源状态只读）。
- 审计：建项目、改来源、同步、审核各记一条（不记 note 原文以外的东西，不记令牌——v1 本来就没有令牌）。

## /work 界面（web/console，单独懒加载块）
- `/work`：项目列表（名字、状态、最新版本 + 审核状态文字、参与者、更新时间），按状态筛；空状态一句 +「添加项目」；错误一句 +「重试」。
- `/work/<id>`：版本时间线（label、标题、产出者、时间、审核状态、产物数）+「同步」（处理中锁住，结果读屏播报：新加 N 个 / 失败原因）。
- `/work/<id>?v=<版本 id>`：版本详情，产物列表（类型、标题、大小、「打开 GitHub ↗」）；GitHub 来源只显示来源状态，不显示审核按钮；公共记忆/助手来源的审核改动走全站确认弹窗。
- 外观照现有组件，不加新样式、不加动画；驾驶舱「进行中」指标卡改跳 /work（有数据时）。
- 前端开关 `FLAGS.work`（web/console/src/lib/flags.ts）默认 false：关着时没有入口，/work 照旧落到对话；`FLAGS` 是常量，关着时 /work 代码被摇掉，不进任何包。
- 体积：对话页包现余 0.12–0.14 kB。/work 页面本身是单独的懒加载块；路由入口只加 routes.ts 里一个 `kind` 和一个 `lazy(() => import('./pages/work'))`，切片 1 先量开关开/关两种构建的对话页包，超了就把入口也放进开关分支里。

## 排序（负责人 #323 小事，切片 2 定）
时间线、单个项目的「最新」、项目列表都用同一个顺序：**有来源时间的版本按来源时间新在前；没有来源时间的（只有 tag）排在它们后面，按写入先后 seq（= GitHub 给的先后）新在前**（PG：`ORDER BY source_at DESC NULLS LAST, seq DESC`，迁移 0034 换了索引）。
不再用 `coalesce(source_at, synced_at)`：那会拿 tag 的同步时间和 release / 公共记忆 / 助手的来源时间比，老仓库补发一个更早的 release 时会排错。
代价（写明白）：项目里既有只打标签的仓库、又有公共记忆或助手时，新打的 tag 也排在有时间的版本后面，「最新」是有时间的最新一条。真要把 tag 插到对的位置得拿到 tag 的时间（要多请求提交接口、或改用带时间的 release），留给以后。
游标 = （来源时间或空, seq），跨过「有时间 → 没时间」两段不丢不重。

## 仍然「需 Core API / 先问」
私有仓库与令牌、自动定时同步与 Webhook、下一个里程碑（GitHub milestones 可作为 v2 来源）、项目删除（破坏性，单独确认）、家人间共享项目、产物上传。

## 切片（每片先写失败测试，草稿 PR）
1. 迁移 0033 + 项目增改查 + GitHub 公开 release 同步 + `/work`、`/work/<id>` 只读（列表、时间线、产物链接）。A+（迁移、RLS、出站请求）。
2. 公共记忆、助手运行两个来源 + 排序改法（迁移 0034，不加表）。（原排第 3，按派工先做；审核顺延）
3. 审核状态（work_reviews + 确认弹窗 + 幂等键）。
4. 驾驶舱指标卡接 /work。
