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
存储：内存、PGlite（**非超级用户、非表所有者的应用角色**连接，RLS 真的生效），CI 设了 `CORE_TEST_DATABASE_URL` 时再跑真 PostgreSQL（同样用应用角色）。所有者和另一个家人账号 B 各建一份带标记的数据；攻击方是小号（会话、Cookie 会话、它自己发的全范围 `arc_` 客户端令牌）。
1. **正向对照**：每条 `/api` 路由先由资源的主人用自己的凭据、自己的 id 打同一个请求，必须 2xx（证明请求真能进处理器）。没跑通 = 测试失败，不跳过；会消耗状态的（删除、取消、停用…）在 `POSITIVE` 里用备用资源。
2. **严格状态码**：只给所有者的（没声明 `userRoute` 的 + `OWNER_ONLY_FOR_FAMILY`）攻击方 == 403；家人能用的在 `FAMILY`（会话）/ `CLIENT`（客户端令牌）里逐条声明期望。「空结果」只给按 scope 过滤的列表接口（`list: true`），响应里不得出现受害者的资源 id。
3. **看不出存在**：家人能用、带 id 的路由，别人的 id 和不存在的 id 都 404（不是 403），错误码一样；请求体里引用 id 的同样对照。
4. **数据库快照**：攻击前后按所有者 / B 的 user_id 直接读库比对（`VOLATILE` 白名单逐列写理由，目前为空）；内存存储没有表，退回到受害者把读接口读一遍。
5. **泄露检查**：标记明文、大小写、base64（含错位）、URL 编码、sha256、掩码后 4 位；范围含响应头（Location / ETag / Content-Disposition）和 SSE 流。检查器本身有自测。
6. **存储层**：应用角色直接 `SELECT` 读不到别人的行、写不进别人名下；注入式身份值（GUC 注入）也读不到。
另外：路径之外的别人的 id（query、body 嵌套字段、`ids` 数组、伪造翻页游标、排序 / 过滤、身份覆盖头）；令牌提权（会话签更大范围 / 所有者级令牌、`arc_` 令牌管理令牌、列出 / 吊销别人的令牌、过期 / 已吊销令牌、已退出会话）；重要确认令牌不跨账号；任务里声明别人的保险箱 id 取不到；`/mcp` 每个工具带别人的 id；`/v1` 客户端令牌只看得到自己的；Cookie 会话的 `/api/chat/stream` 带别人的会话 id 404。

### 新增路由时
- 带路径参数的：在 `PARAM_KIND` 里登记参数是哪类资源。
- 改动类的：在 `BODIES` 里给一份能过校验的请求体（名字类字段用传进来的 `n` 后缀，避免同名冲突）。
- 家人能用的（含不带参数的 GET 列表接口）：在 `FAMILY` 里声明攻击方期望（状态码 + 错误码；列表接口 `list: true`）；客户端令牌能进的：在 `CLIENT` 里声明。只给所有者但声明了 `userRoute` 的：加进 `OWNER_ONLY_FOR_FAMILY`。
- 正向对照跑不通（要前置状态、会消耗资源、B 按设计用不了）：在 `POSITIVE` 里给 `prep` / `victims` 并写 `why`，不许跳过。
- 新资源要真正被测到，在 `seed()` 里给所有者和 B 各建一份（值里带标记；会被掩码的字段带 `TAIL`）。
- 路由总数涨了就把 `MIN_API_ROUTES` 调到新值（少了会失败：说明有路由被 flag / 环境变量关掉没被遍历）。
漏了「覆盖」那条会失败。
