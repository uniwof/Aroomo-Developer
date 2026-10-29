# 本机执行员 ↔ Core 协议（executor-protocol.md）

> 状态：草案 v0.1（执行员线，2026-10-29）。依据 D162、D173、D189、D192。
> Core 端（任务队列、create_task、执行员令牌、接管卡）由后台线实现；执行员端在 `executor/`，
> 在 Core 接口就绪前用本合同 + `executor/test/mock-core.ts` 模拟服务器测试推进。
> 改本合同 = 两边一起改：先改这里，再改 mock-core 和 Core。

## 1. 角色与链路

```
LobeHub Tasks（定时）→ 负责人 → Core MCP create_task ─┐
控制台 / 对话手动派 ───────────────→ Core 任务队列 ←─┘
                                          ▲  出站 HTTPS（长轮询），设备令牌
                              所有者电脑上的本机执行员（executor/）
                                          │
                       浏览器适配器（ego lite 主 / Playwright MCP 备）
                       云手机适配器（DroidRun，连云手机，不在服务器跑模拟器）
```

- 执行员**只发出站连接**，不在所有者电脑上开任何监听端口（经 Cloudflare Tunnel 或 Tailscale 访问 Core 均可）。
- 传输采用 **HTTPS 长轮询**：穿透 Cloudflare Access / 公司网络最稳，断线重连无状态。以后要换 WebSocket 或 MCP（D162 原文「通过 MCP 连 Core」），只换执行员的 `CoreTransport` 适配器，语义不变：本合同的 REST 路由与 MCP 工具一一对应（claim → `claim_task`，result → `submit_result`）。

## 2. 认证

- 设备令牌 = Core 外部客户端令牌（HUB 1.1，B3），放在请求头 `Authorization: Bearer <token>`。
- 需要的新 scope：`tasks:pull`（领取、进度、接管、结果）、`tasks:secret`（按任务取保险箱凭据）。没有 `tasks:secret` 的令牌只能跑不需要凭据的任务。
- 令牌归属某个 user_id：执行员只能领到**这个用户**的任务，取到**这个用户**的保险箱条目（越权测试由 Core 负责）。
- 执行员每个请求带 `X-Aroomo-Executor: <executorId>`（hello 返回）与 `User-Agent: aroomo-executor/<version>`。

## 3. 路由（全部 JSON，前缀 `/api/executor`）

| # | 方法 路径 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| 1 | `POST /hello` | `{ deviceName, platform, version, adapters: ["ego-lite","playwright-mcp","droidrun"], allowlistHash }` | `200 { executorId, pollWaitSec, leaseSec, serverTime }` | 上线登记；控制台据此显示「电脑在线」。同一令牌重复 hello 返回同一 executorId |
| 2 | `POST /tasks/claim` | `{ waitSec ≤ 30, kinds?: string[] }` | `200 { task }` 或 `204` | 长轮询；一个任务只能被领取一次；领取即开始租约 |
| 3 | `POST /tasks/:id/progress` | `{ seq, stage, message, screenshot? }` | `200 { leaseExpiresAt, cancel: bool }` | 同时是心跳：续租。`cancel=true` 时执行员尽快停止并回报 cancelled |
| 4 | `POST /tasks/:id/takeover` | `{ reason, message, screenshot? }` | `201 { takeoverId }` | 推接管卡（收件箱，计入打扰预算 D100）；租约冻结直到处理完 |
| 5 | `GET /tasks/:id/takeover/:tid?waitSec=30` | — | `200 { status: "pending"\|"resolved"\|"cancelled", note? }` | 长轮询等所有者处理 |
| 6 | `POST /tasks/:id/secret` | `{ secretId, field }` | `200 { value }` | 运行时从保险箱取凭据；只能取**任务里声明过**的 secretId；每次调用审计；执行员只放内存，用完即弃 |
| 7 | `POST /tasks/:id/result` | `{ status: "succeeded"\|"failed"\|"cancelled", summary, screenshot?, error? }` | `200 {}` | 结束任务；重复提交同样结果幂等 |

### 3.1 任务对象

```jsonc
{
  "id": "uuid",
  "kind": "checkin" | "login" | "signup" | "browse",
  "site": "https://example.com/",      // 起点 URL，必须命中执行员本机白名单
  "instruction": "自然语言说明（可选）",
  "secrets": [ { "secretId": "uuid", "field": "username" }, { "secretId": "uuid", "field": "password" } ],
  "options": { "cloudOk": false, "markDisposable": false, "device": "pc" },  // markDisposable：注册类账号「封号即丢弃」（D95）
  // device: "phone" 时在云手机 / 安卓上执行（DroidRun），site 写 "android-app://<包名>"，按执行员 allowlist.apps 校验
  "createdAt": "ISO", "leaseExpiresAt": "ISO"
}
```

### 3.2 截图摘要 `screenshot`

`{ "summary": "文字描述（给所有者读屏用）", "width": 0, "height": 0, "sha256": "…" }`——默认**不上传图片本体**，只传文字摘要与哈希；图片上传另开接口（待定），避免把页面上的个人信息带到服务器。

### 3.3 接管原因 `reason`

`captcha` | `2fa` | `payment` | `login_failed` | `not_allowed`（目标跳出白名单）| `other`。

## 4. 时序与规则

- **租约**：默认 600 秒（D162「领取后 10 分钟没回复就退回队列」）。执行员每 ≤ leaseSec/3 发一次 progress 续租。接管等待期间租约冻结。
- **断线重连**：任意网络错误或 5xx → 指数退避 1s、2s、4s … 上限 60s，加 0–30% 抖动；401/403 → 停止领取并提示「令牌失效，请在控制台重新生成」，每 5 分钟重试一次 hello。
- **离线**：执行员不在线时任务排队；`cloudOk=true` 的任务由 Core 交云浏览器（不在本合同范围）。
- **取消**：progress 响应 `cancel=true`，或接管被所有者「取消」→ 执行员关闭页面，提交 `cancelled`。
- **白名单双重校验**：Core 派任务前校验一次（服务器端站点白名单），执行员领取后、每次导航后再按**本机白名单**校验；不命中 → 推 `not_allowed` 接管卡后结束为 failed，绝不访问。
- **凭据**：只在填写那一刻调 #6 取值，只存在内存变量里；所有日志、进度消息、结果、错误都经过脱敏器（把本任务取到的所有值替换成 `[已隐藏]`）。执行员不写任何凭据、cookie 到磁盘（浏览器本身的登录状态由 ego lite 保存在本机，Aroomo 不导出，D162）。
- **审计**：Core 对 claim、secret、takeover、result 全量审计；执行员本地日志只记任务 id、阶段与脱敏后的消息。

## 5. 错误格式

与 Core 一致：`{ "error": { "code": "TASK_NOT_FOUND", "message": "…" } }`。执行员需要识别：`401 UNAUTHORIZED`、`403 FORBIDDEN`（scope 不够）、`404 TASK_NOT_FOUND`、`409 LEASE_LOST`（租约已过期被收回 → 立刻停止该任务，不提交结果）、`422 SECRET_NOT_DECLARED`。

## 6. 版本

- 执行员在 hello 里报 `version`；Core 可在 hello 响应加 `minVersion`，低于则执行员只提示升级、不领任务。
