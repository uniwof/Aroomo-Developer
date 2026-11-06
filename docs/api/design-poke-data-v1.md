# Poke 行为规范缺的 Core 数据 v1（一页设计）

分支 `core/poke-data`。对应审计 `behavior-audit-2026-11-05` 的 C9、M4、I3/I4、§5、§3、§7（清单 4、6、8、10、11 与 1 的 /console）。M5（480 抽屉四标签）等所有者，不做；H5（沙箱、工具分配）本轮不做。

## 需求卡
1. 目标：Poke 规范里只因「Core 没数据」而 FAIL 的项，用 Core 里**真实存在的信号**补上，界面只换文字/状态，不加新样式。
2. 验收：① 成员列表带 `activity`（五态之一 + 依据），状态只从真实信号推出；② 新建/编辑成员能存 角色、系统提示词、头像（emoji/字），系统提示词真的拼进这位成员的对话；③ 收件箱条目带 发起者、影响范围；拒绝可带理由，处理后看得到；④ 对话流接口认会话的群成员名单，没 @ 时只交给群里的人；⑤ /console 驾驶舱只用现有接口，指标卡跳 /inbox /team /hub，动态点开对象。
3. 边界：必做——每条查询带 user_id、RLS 不放宽、字段只加不改；先问——Logs/工具分配/协作记录、480 抽屉；永不——编造状态或百分比、上传/付费存储、密钥进界面或日志（D199）。
4. 假设：成员 = 模型（PRODUCT §9.1），`name` 就是 LiteLLM 模型名；规范的「base model」= 现有 `name`，不另加列（加了要改路由，且两处会不一致）。
5. 测试：core `vitest`（memory + pglite 迁移 up/down/up、RLS 跨账号反向）；console `vitest` + Playwright 假数据截图。

## 已有 / 新增
| 规范项 | 已有 | 新增 |
|---|---|---|
| §4 New Member：name | `members.name`（模型名） | — |
| base model | = `name`（表单里做成可下拉的输入：`<input list>` 列 /api/library 模型，也能手填） | — |
| 称呼 | `members.aliases`（可 @） | — |
| role | — | `members.role text NULL`（≤60 字） |
| system prompt | — | `members.system_prompt text NULL`（≤4000 字）。对话转发前作为这位成员的系统消息（在规矩后面）；负责人派活、@ 点名、`aroomo/<成员>` 都生效；不进日志、不进审计 |
| avatar | 头像按名字取首字 | `members.avatar text NULL`：1–2 个字符（emoji 或字），没有上传、没有存储 |
| §5 状态 | `GET /api/usage`：今天次数、上限、`limited` 次数；`run_steps`：步骤状态 + member_id | `GET /api/members` 每位多一个 `activity`（见下）；`usage` 计数多记 `lastLimitedAt`（只是时间） |
| §8 Actor | `audit_log.actor`（只在审计里） | `inbox_items.actor jsonb NULL` = `{type: member\|assistant\|executor\|system\|client\|owner, id?, name}`；内部调用方填自己，HTTP 发卡 = 调用者令牌（不让请求体冒充） |
| Impact Scope | `actions[].confirm.consequences`（后果，不是范围） | `inbox_items.impact text[] NOT NULL DEFAULT '{}'`（≤10 条，每条 ≤200 字）；没写 = 界面写「未注明」 |
| 拒绝理由 | `resolved_action` | `inbox_items.resolved_note text NULL`（≤500 字）；`POST /api/inbox/:id/actions/:a` 与 `/dismiss` 体里可选 `reason` |
| C9 群成员 | `conversations.group_names`（0028，已存） | `/api/chat/stream` 读会话的 `group_names`（没存会话时认请求体可选 `group`）；有名单时：成员范围只限名单；没 @ = 名单里的人各自回答；@ 名单外的人 = 提示「不在这个群里」 |
| §3 驾驶舱 | 成员、`/api/inbox/unread-count`、`/api/usage`、`/api/audit` | 不加接口 |
| §7 Work | 只有公共记忆版本 | **不做**：Core 没有项目/交付物/版本数据，/work 页写「需 Core API」 |

## 状态推导（`activity`，只读，不存）
按顺序取第一个成立的：
1. `working` 工作中：本账号有 status=running 的助手运行，且它某一步最新事件是 `running`、`member_id` = 这位。依据：运行 id、步骤开始时间。
2. `cooldown` 冷却：今天 `lastLimitedAt` 在 10 分钟内（供应商回过 429）。依据：那个时间；「下次可用」不知道就不写。
3. `depleted` 耗尽：所有者填了每天上限且今天次数 ≥ 上限。依据：「今天的次数已到你填的上限」。
4. `ready` 就绪：在职、启用、有状态正常的 Key（= 现有 `online`）。账号用户（用量不分开记）有可用 Key 也是就绪：2、3 无从判断就跳过，不因此写未知。
5. 其余 `unknown` 未知，附原因：已停用 / 候选 / 没有可用的 Key。
返回 `{state, reason?, since?}`；不返回任何百分比。`shortcut`：只有助手运行（`assistant_runs`/`run_steps`）里正在跑的步骤算工作中；聊天流式回答进行中**不算**（Core 没有按成员的进行中记录），等有需要再加。

## 隔离与迁移
- `0031_member_profile.sql`：`ALTER TABLE members ADD role, system_prompt, avatar`；回退 `down/0031_member_profile.down.sql`：DROP 这 3 列。
- `0032_inbox_decision.sql`：`ALTER TABLE inbox_items ADD actor, impact, resolved_note`；回退 `down/0032_inbox_decision.down.sql`：DROP 这 3 列。
- 两张表已 FORCE RLS（0019、0023），新列跟随行策略，不新增策略。
- 所有读写照旧走 `userScoped(db, userId)` 且 SQL 带 `user_id = $n`；工作中查询只查本账号的 `assistant_runs`/`run_steps`。
- 反向测试：账号 A 看不到账号 B 的成员字段、收件箱 actor/impact/理由；B 的运行不会让 A 的同名成员显示「工作中」。
- 风险档：动了迁移 → **A+**。
