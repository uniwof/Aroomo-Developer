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

## 跨账号遍历（#176，`cross-account.test.ts`）
内存 / PGlite 各跑一遍，CI 设了 `CORE_TEST_DATABASE_URL` 时再跑真 PostgreSQL。所有者和另一个家人账号 B 各建一份带标记的数据，小号（会话，和它自己发的全范围 `arc_` 客户端令牌）对路由表里每条 `/api` 路由：
- 改参：路径参数换成所有者 / B 的真实 id；重放：改动类路由带一份能过校验的请求体（遇到重要确认，小号自己点完两步再重发）。
- 判定：只给所有者的路由（没声明 `userRoute` 的 + 文件里 `OWNER_ONLY_FOR_FAMILY`）一律 403；任何响应不含别人的标记、不 5xx；带别人的 id 和带不存在的 id 结果一样（看不出存在）；打完后所有者和 B 把全部读接口再读一遍，和打之前逐字节一致。
- 另外：所有者的重要确认令牌小号拿去用无效；小号的任务里声明别人的保险箱 id，自己的执行员也取不到；`/mcp` 每个工具带别人的 id 调一遍拿不到别人的数据。

新增路由时：带路径参数的，在 `PARAM_KIND` 里登记参数是哪类资源；改动类的，在 `BODIES` 里给一份能过校验的请求体；只给所有者但声明了 `userRoute` 的，加进 `OWNER_ONLY_FOR_FAMILY`。漏了「覆盖」那条会失败。新资源要真正被测到，在 `seed()` 里给所有者和 B 各建一份。
