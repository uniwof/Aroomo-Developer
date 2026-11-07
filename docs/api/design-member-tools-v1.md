# 成员工具分配 v1（一页设计）

对应 Poke 验收清单第 9 项后半「成员的工具按引用分配到 Hub 资源，不把凭据抄进成员资料」和补充规范 §6 第二段、§4 Assigned Tools。审计 `behavior-audit-2026-11-05` H5、M5（工具部分）。顺带第 9 项的「沙箱算力」：用已有信号，不造新的。

## 需求卡
1. 目标：所有者在成员详情里看到、增减「这位成员分到了哪些工具」，每个工具显示它在 Hub 里的真实状态；工具在 Hub 里被停用或删掉时，分配还在但写明「不可用」，不显示成能用。
2. 验收：① 分配只存引用（工具名），不存 Key、配置、工具定义；② 列表的名字、风险、可用与否全部当场从工具网关（`GatewayService.list`）读，不在库里缓存状态；③ 只有所有者能改，家人账号改 403，读只读到本账号；④ 跨账号读不到、改不了（RLS + 反向测试）；⑤ 增减有进行中/成功/失败三态，写审计；去掉分配先确认。
3. 边界：必做——每条查询带 user_id、ENABLE + FORCE RLS、进 rls-tables.txt、控制台开关默认关；先问——让分配真正限制成员对话里能调的工具（见「仍缺」）、家人账号自己分配；永不——把 Key/令牌/工具配置写进成员或分配表、编造工具状态、HTTP 工具的 secretId 出现在这个接口里（D199）。
4. 假设：Hub 里的「工具」= 工具网关当前账号的清单（内置 `read_webpage`、本机执行员的 `browser_task_*`、所有者登记的 HTTP 工具）。能力清单 `/api/capabilities` 的 tools 是种子目录、不能被成员调用，v1 不收。
5. 测试：core `vitest`（memory + PGlite：迁移 up/down/up、RLS 跨账号、家人 403、工具停用后显示不可用、去重/幂等）；console `vitest`（开关关着不渲染不请求；开着四态、增减、确认）；构建后对话页包 ≤150 kB，`check-flags-shaken` 核对关着时不进包。

## 数据（只用真实信号）
| 显示 | 来源 |
|---|---|
| 分到了哪些工具、什么时候分的 | 新表 `member_tools`（所有者的操作，真实） |
| 工具名、说明、风险（只读/会改东西/花钱前先问/做之前先问） | 工具网关当场列出的清单 |
| 可用 / 不可用 | 工具名此刻在不在网关清单里（HTTP 工具停用或删除、执行员适配器没了 → 不在 → 不可用）。不猜原因，只写「工具在资源库里已停用或删除」 |
| 沙箱算力 | 已有 `GET /api/executors`（电脑助手：设备名、在线 = 90 秒内联系过、最后联系时间）。Aroomo 没有云端沙箱，不造；资源库加一行「算力（电脑助手）」进到已有的 /settings/executors 页 |

## 表（迁移 0034_member_tools，带 down）
`member_tools`：user_id text（非空串）、member_id text、tool text（1–64，形如 `^[a-z][a-z0-9_.-]{0,63}$`，网关工具名）、assigned_at timestamptz、PRIMARY KEY (user_id, member_id, tool)、FOREIGN KEY (user_id, member_id) → members ON DELETE CASCADE（成员彻底删除时一起删；软删除保留）。每位成员最多 50 个（服务层）。ENABLE + FORCE RLS，策略同 0033 模板（`app.user_id` 隔离 + `app.system_scope` 只读）；加进 `scripts/lib/rls-tables.txt`。不是只追加表（去掉分配要真删行；历史在审计里）。

## 接口（Core，挂在已有成员接口下）
- `GET /api/members/:id/tools` → `{ tools: [{ tool, name, description, risk, available, assignedAt }] }`。能力 members:read，账号也能用，只按 `scopeOf(req)` 读；成员不在本账号 = 404（和不存在一样）。不可用的工具 `description`、`risk` 为 null。上限 50 条，不分页（`shortcut: 单页，上限放宽时加 cursor`）。
- `PUT /api/members/:id/tools/:tool` → 分配。只给所有者（所有者令牌 / 方案 A 所有者账号；家人账号 403，先判权限再校验）。工具必须此刻在网关清单里（否则 400「资源库里没有这个工具」）；已分配 = 200 原样返回（天然幂等，键 = 成员 + 工具）。超 50 → 409。
- `DELETE /api/members/:id/tools/:tool` → 去掉分配，204；本来没有 = 404。只给所有者。
- 审计：`member.tool.assign` / `member.tool.unassign`，对象 `{type:'member', id}`，详情只写工具名。

## 界面（web/console，开关 `MEMBER_TOOLS` 默认 false）
- 成员详情（`/team?member=<id>`）加一组「已分配的工具」：每行工具名 + 风险文字 + 「可用」/「不可用：工具在资源库里已停用或删除」+「去掉」（先确认，写明成员和工具）；下面「分配工具」下拉只列网关里还没分给 TA 的工具 +「分配」按钮（处理中锁住、结果用 role=status 播报、失败 role=alert 可再点）。四态：加载 / 空（一句 + 去「工具」页）/ 错（一句 + 重试）/ 有。
- 只给所有者：家人账号不显示这一组（Core 也会 403）。
- 一句实话写在组下面：「分配先记在这里；成员对话里调用工具还没接上，接上后只能用分到的工具。」
- 资源库「资源库里还有」加「算力（电脑助手）」→ /settings/executors（跟同一个开关）。
- 体积：这一组是单独的懒加载块（`MemberTools.tsx`），对话页包只多一个 `lazy()`；开关关着时连这一句也被摇掉。不加新样式、不加动画，用现有 Group/row/btn。

## 仍缺（下一片 / 先问）
1. 让分配生效：成员对话或助手运行能调网关工具时，只给分到的工具（现在对话不调网关工具，所以 v1 分配不改变任何运行行为——界面照实说）。
2. 从 Hub「工具」页按工具看分给了谁、批量分配。
3. 成员抽屉的 Logs / 协作记录（第 7 项，等所有者裁定抽屉 + 标签）。
4. 家人账号给自己的成员分配（先问所有者）。

## 切片
1. 迁移 0034 + 三个接口 + 成员详情「已分配的工具」+ 资源库算力入口，开关默认关。A+（迁移、RLS）。
2. 工具页按工具看分配。
3. 分配生效（接对话/助手的工具调用时一起做，单独设计）。
