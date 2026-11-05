# 会话存库 v1（#250 integrate/stage2，2026-11-05）

checklist：F-036 会话存进 Core、X-21 只追加、X-27 未读 / 进行中、X-04b 收件箱条目 → 会话。**A+**（迁移 + 新接口），负责人 11-08 审。

## 1. 表（沿用 0025，迁移 0028 只加不改，有 down）
- `conversations`：聊天会话 `kind = 'chat'`；新列 `model`（aroomo / aroomo/<成员>）、`group_names text[]`（群聊挑的成员名，前端按名字存）、`archived_at`。RLS 不变（user_id）。
- `conversation_messages`：`role` 多一个 `assistant`（聊天回复，谁答的写在正文末尾署名里，同 /v1）；新列 `meta jsonb`（只放 Core 生成的 X-15 草稿卡 `{draft:{id,data}}`，或导入标记 `{imported:true}`）。仍只追加（0025 触发器拒绝 UPDATE）。
- down：先临时 NO FORCE RLS 删 `role = 'assistant'` 的行，再恢复约束、删列（会丢回复，先 backup.sh）。

## 2. 接口（能力 `chat:use`，所有者 + 家人账号，按 scopeOf 只看自己；别人的 / 助手的会话 = 404）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/conversations?filter=all\|unread\|running&archived=&limit≤100&cursor= | 按 updated_at 倒序分页；每行带 unread、running、messageCount、last 预览 |
| POST | /api/conversations `{id?, title?, model?, group?}` | 客户端可自带 uuid（本机会话发第一句时建，id 不变）；本账号已有 → 200 原样；被别人占用 → 换新 id（不回 409，看不出别人的 id 存在） |
| POST | /api/conversations/import `{conversations:[…≤50, messages ≤500]}` | 一次性导入本机旧会话；按 id 幂等；回复带 imported；不导入草稿卡 |
| GET | /api/conversations/:id | |
| PATCH | /api/conversations/:id `{title?, archived?}` | 改名、归档 / 取消归档。**没有删除** |
| POST | /api/conversations/:id/read | 标已读（unread = read_at 之后有非用户消息） |
| GET | /api/conversations/:id/messages?limit≤200&afterSeq=&beforeSeq= | 按 seq 分页；默认最近 limit 条（升序）+ hasMore |

`POST /api/chat/stream` 多两个可选字段：`conversationId`（先确认是本账号聊天会话，否则 404，不调上游）、`retry`（true = 重试，不再追加用户这句）。回复完整结束才存；点停止存已收到的部分；出错不存。生成期间该会话 running（内存态，单实例 shortcut）。

## 3. 收件箱 → 会话（X-04b，前端已接，Core 还没有产生方）
约定：`related = { type: 'conversation', id: '<会话 id>' }` 或 `'<会话 id>:<消息 id>'`。收件箱里这类条目多一个「打开对话」，点了打开那个会话并滚到那条消息、加焦点框。

## 4. 前端
- 开关 `FLAGS.savedChats`（本分支开）。对话列表从 Core 读；拿不到时退回本机列表（只读提示）。
- 所有者第一次打开：本机旧会话一次性导入（本机那份不删，标记 `aroomo.chat.imported.v1`）。家人账号不导入（同一台浏览器上的本机会话是所有者的）。
- 「全部 / 未读 / 进行中」也作用到对话；「删除话题」换成「归档话题」。

## 5. 待负责人定
1. 迁移 0028 加 `assistant` 角色和 `meta`，而不是用 `member` + member_id（流里拿不到确定的成员 id，署名在正文里）。可以吗？
2. 群聊成员按名字存（`group_names`），成员改名后群里显示旧名。要不要改存成员 id？
3. 导入的回复是浏览器给的文字（带 imported 标记，界面不区分）。X-23「成员消息只由 Core 写」对导入是否放行？
4. 家人账号不导入本机会话（怕把所有者在同一浏览器的会话导进家人名下）；家人自己设备上的本机会话也就看不到了（本机那份还在）。是否接受？
5. 「进行中」是内存态（单实例），重启清空；多实例前要换共享存储。
6. 归档之外的「删除会话」等所有者定（硬删还是软删 deleted_at；要不要重要确认）。
7. 收件箱 → 会话的产生方（例如后台结果写回会话时发条目）放到哪一片做。
