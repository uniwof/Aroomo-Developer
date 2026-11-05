# 一页纸设计：助手（assistants）与「立即运行」v1（线 C，阶段 2，2026-11-05）

状态：设计稿 + 分支实现（`core/assistants-stage2`），**等负责人 11-08 一次性审（A+）**。所有者 11-05 12:19「你只管做，做完一个阶段再让负责人审查」：先在分支上写代码；不进 dev、不上 staging/生产。依据：落地方案 v2.1/v2.2、指南 v1.1 3.3/7.11/7.12/13 章/附录 C、功能补充 v1（X-01/03/13/15/21/23）、`design-rls-v1.md`。

## 1. 表（迁移 0025–0027，每个文件配 `migrations/down/*.down.sql` 回退；全部 RLS，模板同 0019–0024）
| 表 | 关键字段 | 约束 |
|---|---|---|
| `conversations`（会话存库的底座，本阶段只有助手写） | id、user_id、kind chat/assistant、title、member_ids[]、read_at、created/updated/deleted_at | UNIQUE(id,user_id) 供复合外键 |
| `conversation_messages` | id、seq（自增，会话内顺序与分页游标）、conversation_id、user_id、role user/member/system、member_id、run_id、content、created_at | FK (conversation_id,user_id)；**只追加**：触发器拒绝 UPDATE（X-21） |
| `assistants` | 附录 C 全部字段：name、instructions、lead_member_id、enabled、schedule_kind manual/daily/weekly/interval、schedule_spec JSON、timezone、catch_up skip/latest、max_runtime_sec 60–1800（默认 600）、budget_level low/mid/high、notify、conversation_id、next_run_at、paused_at；另加 idempotency_key/hash | FK (conversation_id,user_id)；FK (user_id,lead_member_id)→members ON DELETE SET NULL(lead_member_id)；每账号 ≤20 个（服务层） |
| `assistant_members` | assistant_id、user_id、member_id、role lead/worker、position | PK(assistant_id,member_id)；FK→assistants、FK (user_id,member_id)→members，均 CASCADE；每个助手只有一个 lead（部分唯一索引） |
| `assistant_runs` | trigger manual/schedule、scheduled_for、idempotency_key、requested/started/finished_at、status（附录 C 7 种）、failure_code、summary、usage_state ample/tight/exhausted、calls、message_ids[] | UNIQUE(assistant_id,scheduled_for)=定时幂等键；UNIQUE(assistant_id,idempotency_key)；**部分唯一索引：同一助手只能有一条 queued/running**（不并发，库层兜底） |
| `run_steps`（X-03） | run_id、user_id、seq、step_no、member_id、action plan/work/summarize/confirm、status、detail(≤500)、created_at | **只追加事件**：步骤每变一次状态插一行，当前状态取每个 step_no 的最后一行；触发器拒绝 UPDATE |
- RLS 键三张表都叫 `user_id`（含 members/runs/steps 冗余一列），**待负责人定**（附录 C 写 owner_account_id，见 design-rls-v1 问题 3）。复合外键让跨账号挂接在库层失败。
- failure_code：对话的 4 种 + timeout、budget（附录 C）；**我另加** server_restart（X-21）、no_member（组长/成员都被删或停用）。

## 2. 接口（全部只给所有者：所有者令牌或方案 A 的所有者账号；家人账号 403，操作员/客户端令牌 403；能力名 assistants:read / assistants:write，不进操作员白名单；权限在 preValidation 判，先 403 再校验请求体）
- `GET /api/assistants`（排序：等确认/失败在上，其余按 next_run_at）、`POST /api/assistants`、`GET/PATCH/DELETE /api/assistants/:id`
- `POST /api/assistants/preview`：只校验+算「下次运行」和人话计划，不落库；7.11 实时那一行和 X-15 草稿卡共用，返回 `data-aroomo-assistant-draft` 数据块。
- `POST /api/assistants/:id/runs`（立即运行，202）、`GET /api/assistants/:id/runs?limit=20&before=`、`GET /api/assistants/:id/runs/:run`（含折叠后的步骤）、`POST /api/assistants/:id/runs/:run/cancel`
- `POST /api/assistants/:id/pause`、`/resume`；`GET /api/assistants/:id/messages?afterSeq=`（固定会话，按 seq 分页）、`POST /api/assistants/:id/read`（清未读）
- 错误统一 `{error:{code,message}}`；别人的/不存在的 id 一律 404 且看不出存在；DELETE 是不可逆操作，走统一确认（428 → 两步 → 令牌）。

## 3. 幂等
- 建助手：可带 `Idempotency-Key`，(user_id, key) 唯一；同键同内容返回原助手（200），同键不同内容 409 IDEMPOTENCY_MISMATCH。
- 立即运行：可带 `Idempotency-Key`，(assistant_id, key) 唯一，重复返回同一条运行（200）；没带键而已有 queued/running → 409 RUN_IN_PROGRESS。键随运行记录永久保留（运行只随助手删除）。
- 定时：唯一键 (assistant_id, scheduled_for)，重复占位即放弃。

## 4. 「运行一次」与执行器
- 在 Core 进程内跑，**整次运行都在建它的账号的数据范围里（userScoped），不用超级权限**。组长分工（要求 JSON，解析失败就把任务说明原样给每位成员）→ 成员各做 → 组长汇总写 summary；只有组长一人时组长直接做。转交深度上限 4（借 Ekko handoff-depth）。成员调用复用 ChatService 的 `aroomo/<成员>` 路径（规矩、用量计数照旧）。
- 硬限制：max_runtime_sec 到时整次中止 → failed/timeout；每次与每天调用次数按 budget_level（low 8/40、mid 16/80、high 32/160，配置在 `assistants/budget.ts`，前端不显示数字），每次调用前在库里原子占名额（PG 按账号 advisory lock + UPDATE … RETURNING 带上限条件），并发运行也冲不破每天上限，超出 → failed/budget；**low 只用免费模型**（按成员对应 Key 的真实模型串 `model` 对能力清单的免费项和服务商前缀判定；成员名 / Key 对外名不参与；找不到 Key 部署或判不出算付费；运行中途成员的名字或模型变了 → failed/no_member）：付费成员跳过，组长付费则 failed/budget；mid/high 有付费成员 → 先停在 waiting_confirmation，收件箱发「付费调用」重要确认卡（kind=payment），同意后同一条运行继续，拒绝 → cancelled；同意只对卡上那组付费成员和模型有效（确认步骤记指纹），等确认期间成员组或模型变了 → 同意作废、重发确认卡。外发、删除类动作本阶段成员没有工具可调，不会发生。
- 每次运行写审计 `assistant.run`（谁的助手、触发方式、用了哪些成员、结果）。
- **重启中途**：启动时把 queued/running 的运行改成 failed/server_restart，并在固定会话追加一行系统消息、进收件箱（shortcut：按单实例实现，多实例时改心跳）。跨账号查找用 systemScoped 只读（进白名单），改写切 userScoped。
- 定时循环 `core/src/scheduler/*` 已写、**默认关**（`ASSISTANT_SCHEDULER_ENABLED=false` 时根本不注册任务）：两步认领（systemScoped 只读找到期 → userScoped `FOR UPDATE SKIP LOCKED`）、同一助手不并发、错过的运行：skip 记一条 skipped / latest 只补最近一次、最短间隔 1 小时。阶段 3 才开。

## 5. 结果回会话与收件箱（X-01）、只追加（X-21）
- 每次运行结束，Core 以组长身份把结果写进固定会话（`conversation_messages`，带 run_id），页面关着也写；助手列表带 unread。收件箱：成功且 notify=开 → brief「<助手> 运行完成：…」；失败、等确认 → 一律进 decision。通知正文只放短文字（借 Ekko notification-preview：去 Markdown、≤160 字），不放原始报错。
- 消息、步骤只追加；编辑/重试都是新增一行。

## 6. 测试（全部进 CI，PGlite + CI 真 PG）
RLS 元数据与两账号互不可见（含 4 张新表）；家人/操作员/客户端 403；X-23 ①助手 A 的运行写不进助手 B 的会话（403）②请求里自带作者/成员字段 400，成员消息只能由 Core 写；同助手不并发；幂等；超时停下；预算；付费确认不自动执行；重启 → failed/server_restart；总开关关时不注册定时；错过最多补一次；迁移 up→down→up。

## 7. 待负责人定
1. RLS 键用 `user_id`（同 design-rls-v1 问题 3）。
2. `conversations`/`conversation_messages` 现在由助手先建，会话存库沿用同一张表（还是另设计）？
3. 方案 A 的所有者账号不能完成重要确认（D62/D63）→ 她在新界面上删不了助手、批不了付费运行。是否给所有者账号开放 confirm:important（或助手删除降为普通确认）？
4. 新增 failure_code server_restart、no_member；waiting_confirmation 不占「不并发」名额（否则一张没处理的卡会挡住后面所有运行）。
5. 预算数字（8/40、16/80、32/160 次调用）和「判不出是否免费就当付费」。
6. X-15 草稿卡（integrate/stage2 已做）：所有者账号（scope=owner）在交给负责人的对话（model=aroomo）里说「每周一早上 9 点帮我…」→ `/api/chat/stream` 不调模型，负责人回一句话 + `data-aroomo-assistant-draft`（同一个 preview，组长 = 当前负责人，额度档低）。认法只用规则（`assistants/intent.ts`）：要有计划（每天 / 每周几 / 工作日 / 周末 + 几点，或每 N 小时）且计划在请求词（帮我 / 替我 / 提醒我…）前面；问句、否定、改 / 取消已有的、@点名、每月、晚上 12 点、超过 300 字都不认。家人账号、单独和成员的对话照常走路由。前端点「建好」才 POST（Idempotency-Key = 卡的 id），「改一改」打开预填的新建弹窗，「不用了」收起。**待负责人定**：认法范围是否合适；卡里组长默认当前负责人、成员只有组长一人。
