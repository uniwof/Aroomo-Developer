# 流里的数据块和步骤状态（C 线维护，A 线只读）

`POST /api/chat/stream` 输出 Vercel AI SDK UI Message Stream（SSE）。正文是 `text-start / text-delta / text-end`；Aroomo 自己的结构化内容用 `data-aroomo-*` 部件。浏览器只读这些部件，**不能发**：请求里带的同名部件 Core 一律忽略（X-23）。

| 部件 | 何时发 | transient | 存进会话 |
|---|---|---|---|
| `data-aroomo-failure` | 整条回复失败，紧跟在 `error` 前 | 是 | 否 |
| `data-aroomo-assistant-draft` | X-15 草稿卡（只给所有者） | 否 | `meta.draft` |
| `data-aroomo-tool` | X-05 工具调用（见 §1） | 否 | `meta.tools` |

## 1. `data-aroomo-tool`（X-05 工具调用过程可见，A+）

```jsonc
{ "type": "data-aroomo-tool", "id": "<messageId>_tool_<index>", "data": {
  "index": 0,                 // 这条回复里第几个工具调用（0 起）
  "name": "search",           // 工具名，只含 [A-Za-z0-9_.-]，≤64
  "label": "搜了网页",          // 人话，界面直接显示
  "state": "done",            // done 拿到结果 | failed 没拿到结果 | unavailable 模型想用、但这个工具没开放给成员（没执行）
  "count": 5,                 // 结果条数，知道时才有
  "summary": "5 条结果",       // 一句摘要，≤120 字，已脱敏
  "args": "{\"query\":\"…\"}",  // 只给所有者：脱敏后的参数（JSON 文本，≤1000 字）
  "result": "…"               // 只给所有者：脱敏后的结果摘录（≤1500 字）
} }
```

- **来源**只有上游流里的结构化字段：`choices[].delta.executed_tools`（服务商替模型执行过的工具，带 `output` / `search_results`）和 `choices[].delta.tool_calls`（模型想调的函数；Core 现在不给成员开工具，记 `unavailable`）。模型正文里漏出的工具标记不算。
- **同一个 id 会发多次**：新出现一个调用、或某个调用拿到结果时即时发一次；回复结束（`text-end` 之后）再把每个调用的最终状态发一次。浏览器按 `id` 覆盖。
- **脱敏在 Core 做完**（D199 红线 1）：键名像 key / token / secret / password / cookie / authorization / session / signature 的值整值换成 `【已隐藏】`；文字里像密钥的串（sk- / gsk_ / ghp_ / Bearer … / 32 位以上十六进制 / 40 位以上无空格串）换掉；网址去掉账号密码、查询参数和 #片段（`https://a.com/p?…`）。
- **按账号**：所有者账号（scope = owner）有 `args`、`result`；家人账号只有 `summary`（参数和结果原文不发、不存）。
- **上限**：一条回复最多 20 个调用；存库时整组 ≤15000 字，超了从后往前先去 `result`、再去 `args`，`summary` 总在。
- 读历史：`GET /api/conversations/:id/messages` 的回复带 `tools: ToolPartData[]`（和流里最后一次发的 data 一样）。

## 2. 助手运行步骤状态（X-06 分工的送达状态，A+，迁移 0029）

`GET /api/assistants/:id/runs/:run` 的 `steps[].status`（每个 step_no 取最后一条事件）。

| status | 成员那一步（action = work）显示 | 组长那几步 / 确认 |
|---|---|---|
| `pending` | 已派出（组长分完工，Core 还没交给成员的模型） | 等待 |
| `received` | 已收到（成员的模型接下了这件事，还没回字） | —（不经过） |
| `running` | 在做（第一个字到了） | 进行中 |
| `done` | 已回复 | 完成 |
| `failed` / `skipped` / `waiting_confirmation` | 失败 / 跳过 / 等你确认 | 同左 |

- 成员调用是流式（`stream: true`, `stream_options.include_usage`），200 头到了记 `received`，第一个正文字到了记 `running`；网关不接（401/429/连不上）直接 `pending → failed`。
- 「成员没反应」：卡在 `pending` = 还没交出去（排队 / 额度）；卡在 `received` = 模型接了但一直没回字。
