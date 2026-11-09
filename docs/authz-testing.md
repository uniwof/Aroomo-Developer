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
存储：内存、PGlite（**非超级用户、非表所有者的应用角色**连接，RLS 真的生效）、真 PostgreSQL（同样用应用角色，`CORE_TEST_DATABASE_URL`）。**CI 里真 PG 必跑**：`CI=true`（GitHub Actions 自带）或 `AROOMO_REQUIRE_REAL_PG=1` 时没配 `CORE_TEST_DATABASE_URL` 直接失败（不是跳过）；本地没配才跳过。所有者和另一个家人账号 B 各建一份带标记的数据；攻击方是小号（会话、Cookie 会话、它自己发的全范围 `arc_` 客户端令牌）。测试环境关掉进程内定时任务（`CORE_JOBS=off`），免得慢机器上定时任务在攻击中途改数据、弄脏快照。
1. **正向对照**：每条 `/api` 路由先由资源的主人用自己的凭据、自己的 id 打同一个请求，必须 2xx（证明请求真能进处理器）。没跑通 = 测试失败，不跳过；会消耗状态的（删除、取消、停用…）在 `POSITIVE` 里用备用资源。
2. **严格状态码（单值）**：只给所有者的（没声明 `userRoute` 的 + `OWNER_ONLY_FOR_FAMILY`）攻击方 == 403；家人能用的在 `FAMILY`（会话）/ `CLIENT`（客户端令牌）里逐条声明**一个**状态码 + 错误码（类型上就不许写数组）。跟攻击方自己状态有关的（`DELETE /api/memory/:topic` → 404、`claim` → 204），由 `ATTACK_PREP` 在每个攻击请求前把攻击方状态摆好，不依赖遍历顺序。「空结果」只给按 scope 过滤的列表接口（`list: true`），响应里不得出现受害者的资源 id。
3. **看不出存在**：家人能用、带 id 的路由，别人的 id 和不存在的 id 都 404（不是 403），错误码一样；请求体里引用 id 的同样对照。
4. **路径之外的别人的 id**：身份覆盖头、query（`ids` 数组、伪造翻页游标、排序 / 过滤）、请求体嵌套字段**分三个独立请求**发。头注入必须和声明的期望完全一样；只给所有者的路由三种都严格 403、不接受 400；家人能用的 query / body 注入允许声明的期望或 **schema 校验的 400**（`BAD_REQUEST` 且带 `fields`，只有 `http/errors.ts` 的校验分支这样回；处理器的业务 400 算失败），并且每条都再拿不存在的 id 做同样的注入，状态码和错误码必须完全一样。`adminGuard` 已挂 preValidation（#349），`VALIDATES_BEFORE_ADMIN_CHECK` 现为空、不再往里加；新的鉴权检查一律挂 onRequest / preValidation，`test/admin-guard.test.ts` 的结构测试会拦住挂在 preHandler 的管理员检查。
5. **数据库快照**：攻击前后按所有者 / B 直接读库比对（`VOLATILE` 白名单逐列写理由，目前为空）。**逐表正向对照**：攻击前每张表 owner 和 B 都要至少一行，否则失败；按设计一方不可能有行的写进 `SNAPSHOT_SIDE_EXEMPT`（逐条理由；不再需要的豁免也会失败）。新表自动纳入，所以加表要么在 `seed()` 里建数据，要么写豁免。内存存储没有表，退回到受害者把读接口读一遍。
6. **泄露检查**：标记明文、大小写、base64（含错位）、URL 编码、sha256、掩码后 4 位；范围含响应头（Location / ETag / Content-Disposition）和 SSE 流。检查器本身有自测。
7. **存储层**：应用角色直接 `SELECT` 读不到别人的行；注入式身份值（GUC 注入）也读不到。**写操作逐表**：每张 RLS 表，小号 UPDATE / 改归属 / DELETE 别人的行影响 0 行（应用角色没这种权限也算过），往 owner / B 名下 INSERT 必须被 RLS 拒（报错不是 RLS 的也算失败）；每条在事务里做完即回滚。**没开 RLS 的表必须正好等于 `NO_RLS_TABLES` 白名单**，新增没开 RLS 的表会失败。每张 RLS 表：系统范围（只读策略）按 owner / B 数出的行数必须等于各自范围数出的行数（系统只读策略漏行时快照会漏看）。
8. **/mcp**：`MCP_POSITIVE` 是逐工具正向对照表，`tools/list` 里的每个工具都要登记，主人用自己的令牌、自己的 id 调用必须成功（多数还要认得出自己的标记；`call_tool` 测试不联网，只证明过了放行检查）；攻击方的参数从 `MCP_POSITIVE` 推（不按参数名猜），所有工具都不能泄露；带 id 的 4 个工具（`get_task`、`cancel_task`、`get_library_item`、`get_memory`）用「别人的 id」和「不存在的 id」各调一次，报错（JSON-RPC error / isError / 文本，查询值本身换成占位）必须完全一样。
9. **执行员取凭据**：任务声明了别人的 secretId 和声明了不存在的 secretId，一样 404 `SECRET_NOT_FOUND`；没声明的别人的和没声明的不存在的，一样 422 `SECRET_NOT_DECLARED`；正向对照是声明了自己的能取到。
另外：令牌提权（会话签更大范围 / 所有者级令牌、`arc_` 令牌管理令牌、列出 / 吊销别人的令牌、过期 / 已吊销令牌、已退出会话）；重要确认令牌不跨账号（小号拿所有者的令牌删自己的条目 = 403）；`/v1` 家人会话令牌（Bearer 和 Cookie）= 401 `UNAUTHORIZED`（测试配了占位 `CORE_CHAT_TOKEN`，鉴权真的走到；所有者对话令牌正向对照 200），客户端令牌 = 200 且只看得到自己的；Cookie 会话的 `/api/chat/stream` 带别人的会话 id 404。

### 自证（故意改坏）
`scripts/authz-selfcheck.sh`：逐个打上 `core/test/authz/self-check/*.patch`，跑跨账号测试，断言被**预期的那项检查**抓到，再还原（要求 `core/src` 干净；退出时一定还原）。
- `library-get-cross-read.patch`：`GET /api/library/:id` 找不到时退回所有者范围 → 越权读。三种存储都要被遍历用例抓到（严格 404 / 泄露）。
- `interrupt-budget-cross-write.patch`：`PUT /api/interrupt-budget` 顺手写进所有者的设置，响应照常 200 → 只有数据库快照能抓。`pglite-app-role` 和 `postgres-app-role` 都必须被快照抓到（`core_settings`）；内存存储没有表，抓不抓得到只打印、不作要求（已知局限）。
真 PG 规则同上：CI 里没配 `CORE_TEST_DATABASE_URL` 脚本直接失败。

CI：`ci.yml` 的 Core job 带 `postgres:17-alpine` 服务容器并设 `AROOMO_REQUIRE_REAL_PG=1`，`npm test` 跑全量（含真 PG 段）；`authz.yml` 在改到鉴权 / 数据库层 / authz 测试的 PR 上再单跑 authz 套件（真 PG）和自证脚本，并检查跑完工作树干净。

### 新增路由时
- 带路径参数的：在 `PARAM_KIND` 里登记参数是哪类资源。
- 改动类的：在 `BODIES` 里给一份能过校验的请求体（名字类字段用传进来的 `n` 后缀，避免同名冲突）。
- 家人能用的（含不带参数的 GET 列表接口）：在 `FAMILY` 里声明攻击方期望（状态码 + 错误码；列表接口 `list: true`）；客户端令牌能进的：在 `CLIENT` 里声明。只给所有者但声明了 `userRoute` 的：加进 `OWNER_ONLY_FOR_FAMILY`。
- 正向对照跑不通（要前置状态、会消耗资源、B 按设计用不了）：在 `POSITIVE` 里给 `prep` / `victims` 并写 `why`，不许跳过。
- 攻击结果跟攻击方自己的状态有关：在 `ATTACK_PREP` 里把状态摆好，期望仍只写一个状态码。
- 新 MCP 工具：在 `MCP_POSITIVE` 里登记参数和期望（`mark` / `ok`），带资源 id 的标 `takesId`。
- 新表：在 `seed()` 里给 owner 和 B 各建一行，或在 `SNAPSHOT_SIDE_EXEMPT` 写理由；不开 RLS 的要进 `NO_RLS_TABLES` 并写理由。
- 新资源要真正被测到，在 `seed()` 里给所有者和 B 各建一份（值里带标记；会被掩码的字段带 `TAIL`）。
- 路由总数涨了就把 `MIN_API_ROUTES` 调到新值（少了会失败：说明有路由被 flag / 环境变量关掉没被遍历）。
漏了「覆盖」那条会失败。
