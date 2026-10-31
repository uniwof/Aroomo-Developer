# 越权测试（D208）

位置：`core/test/authz/`，随 Core 的 `npm test` 在 CI 里跑。依赖隔离线的 `core/test/helpers/two-accounts.ts`（只复用，不改）。

## 检查什么
1. 每条 `/api` 路由必须在路由选项里声明权限：`guard('xxx:read')`（capability）、`config.clientScope` 或 `config.clientSelf`。漏声明 → `每条 /api 路由都声明了权限` 失败。
2. 无令牌访问所有 `/api` 路由 → 必须 401/503。
3. 小号（普通账号）访问没标 `userRoute` 的路由 → 必须 403/401；标了 `userRoute`（`guard(cap, { user: true })`）的不得 5xx，数据隔离由各自的两账号测试负责。

## 新增路由怎么做
- 在路由上用 `...guard('<能力>')`；账号也要用就加 `{ user: true }`，并按 `scopeOf(req)` 取本人数据。
- 不要往 `owner-only-baseline.ts` 里加条目（只许删）。确实要只给所有者且不声明，必须在 PR 里写理由并由负责人审。
- 登录前就要访问的路由，加进 `authz.test.ts` 的 `PUBLIC_API` 并写理由。

## 故意验证
临时加一条 `app.get('/api/zzz', ...)` 不带 guard，`npx vitest run test/authz` 应失败并列出该路由。

## 还没做
改动类接口的重放与改参测试：待各线路由稳定后按路由补进 `core/test/authz/`。
