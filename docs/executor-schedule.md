# 定时签到 / 派任务：LobeHub Tasks → Core → 本机执行员

> 执行员线写；M3 的「LobeHub 定时签到」用。Core 现状：`POST /api/tasks` 已在 dev；`/mcp` 的 `create_task / get_task / list_tasks / cancel_task` 在 PR #117（待负责人审，合并后可用）。

## 一图

```
LobeHub Tasks（定时）→ 负责人智能体 → Core MCP create_task ─┐
所有者在控制台点「现在就签到」 → POST /api/tasks ─────────────┤→ 任务队列 → 本机执行员长轮询领取
Core 自带定时（pg-boss，备选，不依赖 LobeHub）────────────────┘      → 遇验证码推接管卡 → 回报结果
```

## 1. 直接调 HTTP（现在就能用）

```bash
# ARO_TOKEN 是控制台生成的「人类/客户端令牌」，不要写进脚本或仓库
curl -sS -X POST "$CORE/api/tasks" \
  -H "Authorization: Bearer $ARO_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "kind": "checkin",
    "site": "https://example.com/daily",
    "instruction": "找到签到按钮并点击；今天已签到就说明已签到",
    "secrets": [
      {"secretId": "<保险箱条目 uuid>", "field": "username"},
      {"secretId": "<保险箱条目 uuid>", "field": "password"}
    ],
    "options": {"cloudOk": false}
  }'
# → 201 {"task": {"id": "...", "status": "queued", ...}}
curl -sS "$CORE/api/tasks/<id>" -H "Authorization: Bearer $ARO_TOKEN"   # 看进度/结果
```

要点：
- `secrets` 只放保险箱条目的 id 和字段名，**不放值**；执行员运行时才按 id 向 Core 取，用完即丢。
- `site` 必须在执行员本机白名单里，否则执行员推一张「网站不在白名单」接管卡并失败。
- 命中 `recipes.json` 里的站点配方就按配方走，配方出错自动退回通用办法（见 executor/README.md）。

## 2. LobeHub Tasks 定时触发（M3）

在 LobeHub 里建一个定时任务（每天 09:00），指派给「负责人」智能体，任务描述这样写：

```
调用工具 create_task：kind=checkin，site=https://example.com/daily，
secrets 用保险箱条目「example 账号」。创建后不用等结果；
完成时收件箱会有通知。如果工具返回错误，把错误原文告诉我。
```

负责人通过 Core 的 MCP 调用（工具定义见下）。**不改 LobeHub**（D199 红线），只用它原有的「定时任务 + MCP 工具」。

### Core MCP 工具（PR #117 的实现，以此为准）

接入：控制台「设置 → MCP 配置」一键复制（地址 `<Core>/mcp`，Bearer 为客户端令牌）。令牌要勾范围 `tasks:create`（派/取消）和 `tasks:read`（查）。

| 工具 | 入参 | 返回（文本一行） | 范围 |
|---|---|---|---|
| `create_task` | `kind`(checkin/login/signup/browse)、`site`、`instruction?`、`secrets?[{secretId,field}]`、`options?` | `已派给本机执行员。- checkin <site> 状态 queued（id: …）` | `tasks:create` |
| `get_task` | `id` | `- <kind> <site> 状态 <status>：<摘要>（id: …）` | `tasks:read` |
| `list_tasks` | `status?` | 最近 20 条，每条一行 | `tasks:read` |
| `cancel_task` | `id` | 同上，状态变 cancelled | `tasks:create` |

约束：只用调用者自己的令牌和 user_id，看不到别人的任务和 secretId；`secrets` 只传保险箱条目 id 和字段名，不传值。

## 3. 重复触发的去重（建议）

同一 `kind + site + 当天日期`（北京时间）已有未取消、未失败的任务时，`create_task` 回「今天已经派过」并给出已有任务（避免 LobeHub 重试造成重复签到）。这是 Core 端行为（#117 已实现）；执行员端不依赖它。

## 4. 备选：Core 自带定时

LobeHub 定时不稳时，用 Core 的 pg-boss 建 `schedules` 表（`user_id`、cron、任务模板），到点调用同一个 `svc.create`。只在 V4 验证不过时启用。
