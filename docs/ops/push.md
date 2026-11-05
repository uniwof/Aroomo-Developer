# 推送提醒（X-08，PWA 网页推送）

手机或电脑锁屏上收到一句提醒：「有事等你确认」「助手运行完成」「助手运行失败」。点开进 Aroomo 的收件箱。第一版只给所有者。

## 打开（服务器）

1. 生成密钥（只生成一次；换密钥 = 所有设备要重新打开）：
   ```
   node scripts/gen-vapid-keys.mjs mailto:你的邮箱
   ```
   把打印出的三行贴到服务器 `deploy/.env`（权限 600），再加一行 `PUSH_ENABLED=true`。
2. 重启 core：`docker compose up -d core`。
3. 默认 `PUSH_ENABLED=false`：接口返回 503（`PUSH_DISABLED`），不发任何推送；设置里只显示「服务器还没有打开推送提醒」。

环境变量：

| 变量 | 说明 |
|---|---|
| `PUSH_ENABLED` | `true` / `false`（默认 false） |
| `VAPID_PUBLIC_KEY` | 65 字节公钥，base64url（会发给浏览器） |
| `VAPID_PRIVATE_KEY` | 32 字节私钥，base64url。**只在服务器 .env，不进仓库、日志、聊天** |
| `VAPID_SUBJECT` | `mailto:邮箱` 或 `https://网址` |

`PUSH_ENABLED=true` 但三项不全或公私钥不是一对时，Core 启动失败并说明原因。

## 打开（每台设备）

设置 → 推送提醒 →「在这台设备上打开」。只有点了这个按钮，浏览器才会问是否允许通知（不会自动弹）。打开后可以点「发一条试试」。

- **iPhone / iPad（iOS 16.4 及以上）**：必须先在 Safari 里点「分享」→「添加到主屏幕」，再从主屏幕上的 Aroomo 图标打开，才能打开推送提醒。直接在 Safari 网页里打开收不到（这是苹果的限制）。
- Android Chrome、电脑上的 Chrome / Edge / Firefox / Safari：直接在网页里打开即可。
- 浏览器之前拒绝过通知：要先在浏览器的网站设置里把「通知」改回允许。
- 一个账号最多 10 台设备。

## 发什么、不发什么

- 触发：收件箱新建条目时——助手运行完成、运行失败、有卡片等你确认（`decision` 分组且带按钮）。同一件事去重命中不再发。
- 推送内容只有 `{ title, url, tag }`：固定短标题 + `/console/chat?view=inbox`。**不放条目标题、成员名、金额、正文。**
- 推送经过浏览器厂商的推送服务（Google FCM、Apple、Mozilla、Microsoft），内容按 RFC 8291 端到端加密，推送服务看不到内容。
- Core 只向这些推送服务的 https 地址发（`fcm.googleapis.com`、`*.push.apple.com`、`*.push.services.mozilla.com`、`*.notify.windows.com`、`android.googleapis.com`），别的地址订阅时直接 400。
- 推送服务回 404 / 410（设备取消了订阅）时自动删掉这台设备；其他失败只记状态码，不记推送地址。

## 回退

- 关掉：`PUSH_ENABLED=false` 重启 core。
- 删表：`core/migrations/down/0029_push_subscriptions.down.sql`（只删推送订阅，设备重新打开即可）。

## 接口（只给所有者：所有者令牌或方案 A 的所有者账号；家人、操作员、客户端令牌一律 403；能力 `push:manage`，不进操作员白名单）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/push` | `{ enabled, publicKey, devices }`；不回任何推送地址 |
| POST | `/api/push/subscriptions` | 请求体 = 浏览器 `PushSubscription.toJSON()`；新设备 201，已有 200；超过 10 台 409 |
| POST | `/api/push/subscriptions/remove` | `{ endpoint }`，只删本账号的；没有也 200 |
| POST | `/api/push/test` | 给本账号所有设备发一条「Aroomo 推送提醒已打开」，回 `{ sent }` |

表 `push_subscriptions`（迁移 0029）按 `user_id` 开 RLS（同 0019 模板），`UNIQUE (user_id, endpoint)`。
