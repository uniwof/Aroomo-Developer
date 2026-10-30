# 资源中枢设计（HUB.md）

> 对应决策：D118（资源中枢）、D111/D117（多用户）、D62/D63（操作员白名单与统一确认）、D73（Key 操作确认）。
> 对应阶段：PROGRESS 阶段 B 的 B2–B6。**本文是实现前的合同：与 DECISIONS 冲突时以 DECISIONS 为准，并在此标「待负责人确认」。**
> 原则：**界面无关**。本文所有接口都挂在 Core（或 Core 前的网关层），不依赖 LobeHub 或任何其他界面（所有者 2026-10-29：界面可能更换，尚未决定）。

## 0. 总图

```
任何界面 / 外部智能体 / 其他软件
        │  ① 账号会话令牌（人，B1）  ② 客户端令牌（程序，B3/B4）
        ▼
   Core 网关层：鉴权 → 限额 → 确认 → 审计 → 路由
        ├─ /v1/*            OpenAI 兼容（B4）→ LiteLLM（模型 Key 在 LiteLLM）
        ├─ /mcp             对外 MCP（B3 只读；B5 调工具）
        ├─ /api/tools/*     工具网关（B2）→ 保险箱取密钥 → 调第三方
        ├─ /api/vault/*     保险箱（B2）
        └─ /api/memory/*    公共记忆与交接包（B6）
```

所有业务数据从第一天带 `user_id`（B1b 已定义：文本；`owner` = 所有者令牌的数据，账号用户 = users.id）。**接口层只允许通过 `scopeOf(req)` 取归属，模块存储层一律提供 `forUser(userId)` 视图**（见 core/src/members）。

## 1. 身份与令牌（B1 已有，B3 扩充）

| 谁 | 令牌 | 前缀 | 存储 | 能做什么 |
|----|------|------|------|----------|
| 人（账号） | 会话令牌 | `ars_` | SHA-256 | 本人数据的全部普通操作 |
| 所有者（运维） | `CORE_OWNER_TOKEN` | — | 环境变量 | 全部；重要确认的唯一主体（D62） |
| 操作员（负责人） | 操作员令牌 | — | HMAC | D62 白名单 |
| **外部客户端（新）** | 客户端令牌 | `arc_` | SHA-256 | 只有创建时勾选的**范围（scope）**，见 1.1 |

### 1.1 客户端令牌（B3）
- 由某个用户为某个客户端创建（例如「我的 Claude Desktop」「脚本 X」）；**一个客户端一枚令牌**，不共用。
- 表 `client_tokens`：`id, user_id, name, token_hash, scopes text[], created_at, expires_at, last_used_at, revoked_at, rate_limit_per_min`。
- 明文只在创建时显示一次；列表只显示名字、范围、最后使用时间。
- **最小权限**：scope 是白名单，默认空。初期范围：`bookmarks:read`、`memory:read`、`brief:read`、`tools:list`、`models:chat`（B4）；`tools:call:<tool_id>`（B5，逐个工具授予）。
- **一键吊销**：`DELETE /api/clients/:id` 立刻生效（下一次请求就拒绝，不缓存）；另有「吊销我的全部客户端令牌」。
- **客户端令牌不能**：管理账号、创建/读取保险箱内容、创建另一枚令牌、做任何「重要确认」。这些只属于人的会话。
- 速率限制：每令牌每分钟计数，超限 429，写审计 `client.rate-limited`。
- 审计：每次调用写一条（令牌 id、user_id、scope、接口、结果、耗时）；**全量审计，不采样**。请求/响应体不入审计（可能含敏感内容），只记工具名与参数键名。

## 2. 保险箱（B2）

### 2.1 存什么、不存什么
- **存**：工具类密钥（搜索 API、邮箱、第三方服务的 Key / Token / 密码、网页代办身份）。
- **不存**：模型服务商 Key——仍然只在 LiteLLM（KEY-STORAGE.md，D34/D45），保险箱不重复保存。

### 2.2 加密
- 信封加密：每条记录一把随机数据密钥（DEK，AES-256-GCM），DEK 用 `VAULT_KEY`（环境变量，32 字节 base64，**只在服务器 `.env`，600**）加密后随记录存放；`aad = user_id || secret_id`，防止把 A 的密文拷到 B 名下解密。
- `VAULT_KEY` 与 `LITELLM_SALT_KEY` 一样：**添加第一条记录前必须设好，启动时检查**：库里已有记录而 `VAULT_KEY` 缺失或指纹不符 → 拒绝启动，不静默降级。指纹（`SHA-256(VAULT_KEY)` 前 8 字节）存在 `core_settings`，不是秘密。
- 备份：保险箱表随数据库一起被现有加密备份（D64）覆盖；`VAULT_KEY` 在 `.env` 内，随 `.env` 进加密包。恢复演练必须包含「恢复后能解开一条测试记录」。
- 表 `vault_secrets`：`id, user_id, name, kind (api_key|token|password|note), last4, ciphertext, dek_wrapped, nonce, created_at, updated_at, rotated_at, deleted_at`。`(user_id, lower(name))` 在未删除记录里唯一。

### 2.3 操作与确认（沿用 D73）
| 操作 | 谁 | 确认 |
|------|----|------|
| 新建 / 替换（用户手动填写） | 人的会话 | 普通保存 |
| 查看明文 | 人的会话 | **重要确认**（D63，二次验证） |
| 导出 / 删除 | 人的会话 | **重要确认** |
| 任何操作 | 客户端令牌、操作员、MCP | **一律拒绝**（没有 `vault:*` scope，不存在） |

- 列表 / 详情接口永远只返回 `name, kind, last4, 时间`，**没有任何接口返回明文**，除了「查看明文」且需要确认令牌。
- 日志与审计走现有脱敏（audit/redact.ts）；新增 `vault.*` 动作，审计里没有值。

### 2.4 实现状态（B2a）
- 已实现：`core/src/vault/`（信封加密、store、service、routes）、迁移 0012、`GET/POST /api/vault`、`PUT /api/vault/:id`（只替换内容）、`POST /api/vault/:id/reveal`（凭据类重要确认）、`DELETE /api/vault/:id`（不可逆确认，清空密文）。
- 仅本人（所有者令牌、账号）可用；操作员与客户端令牌 403。**账号目前不能查看明文 / 删除**（`principalCan` 对账号为 false，等 7.1 第 1 步「密码重新验证」）；账号可新增、替换、列表。
- 启动检查在 `index.ts`：库里有记录而 `VAULT_KEY` 缺失/指纹不符 → 进程退出。
- **待办（后续 PR）**：①独立版安装器的 `$dataKeys`（还原时保留的密钥名单，installer/standalone/AroomoStandalone.psm1）加入 `VAULT_KEY`；②备份恢复演练加「恢复后能解开一条测试记录」；③导出接口。

## 3. 工具网关（B2）

- 工具 = 一条登记：`tool_id, user_id, name, base_url, auth {type: bearer|header|query, secret_id, header_name}, allowed_hosts[], risk (read|write|spend|danger), per_day_limit, enabled`。
- 网关**代用户调用**：只有网关读取保险箱里的值（进程内解密，用完即丢），**值不返回给调用方、不进模型上下文、不进日志**。
- 安全边界（照搬 AUDIT 对 SSRF 的结论）：仅 https；目标主机必须在 `allowed_hosts`；解析后的 IP 拒绝私网 / 回环 / 链路本地 / 云元数据；每跳重定向重新校验，≤ 3 跳；10 秒超时；响应 ≤ 1 MB；不跟随跨主机重定向携带凭据。
- 风险分级与确认：`read` 直接执行；`write` 首次需要用户在人的会话里批准该工具 + 参数范围；`spend` 与 `danger` **每次**重要确认（D118「花钱或危险操作需所有者确认」），客户端令牌无法自己确认——请求挂起为收件箱卡片，等人确认后才执行（超时 10 分钟作废）。
- 额度：`per_day_limit` 按 user_id 分别计数（D117-20）。
- 与 PRODUCT 9.6 的关系：PRODUCT 写「所有工具统一成 MCP 挂在 MetaMCP」。**实现注（待负责人确认）：** 标准版不带 MetaMCP（PRODUCT 7.3），工具网关由 Core 自带最小实现，接口形状与 MCP `tools/call` 对齐，以后可换 MetaMCP 而客户端不用改。

## 4. 对外 MCP（B3 只读 → B5 调工具）

- 端点 `POST /mcp`（Streamable HTTP，JSON-RPC 2.0；只实现 `initialize`、`tools/list`、`tools/call`、`ping`）。鉴权：`Authorization: Bearer arc_…`。
- B3 只读工具（每个对应一个 scope）：
  - `search_bookmarks(query, limit)` → `bookmarks:read`（数据来自 Karakeep，按 user_id 过滤）
  - `get_memory(topic)` / `list_memory_topics()` → `memory:read`（公共记忆，见 5）
  - `get_brief()` → `brief:read`（交接包）
  - `list_tools()` → `tools:list`（只列该客户端被授权的工具，不含凭据信息）
- B5：`call_tool(tool_id, args)` → 需要该 `tools:call:<tool_id>` scope；按第 3 节风险分级执行。
- `tools/list` 按 scope 动态返回：没权限的工具不出现。`tools/call` 对未授权工具返回统一的「不存在」，不泄露存在性。
- 输出过滤：返回给外部客户端的文本先过 `redactSecrets`；敏感项目（D38）的内容不经 MCP 暴露。

## 5. 公共记忆与交接包（B6）

- 公共记忆 = 用户**明确允许共享给所有成员/外部客户端**的事实（偏好、项目背景、规矩），不是对话全文。条目：`id, user_id, topic, body, source (user|lead|import), created_at, updated_at, version`，保存在 Core（PostgreSQL），不依赖 OpenMemory（标准版不带，PRODUCT 7.3）。
- 写入：人的会话直接写；负责人（操作员令牌）提议的条目进收件箱，人确认后生效（D73 精神）。客户端令牌**不能写**（B3/B5 都不开放）。
- 交接包 `GET /api/brief`（同内容经 MCP `get_brief`）：成员、工具（仅名称与状态）、项目进度、规矩、偏好、待办、遗留问题的汇总，Markdown。同时可一键复制成「新智能体开场白」（I3）。**不含任何密钥、不含其他用户的数据。**
- 版本：每次变更 `version +1`，审计 `memory.write`；可回滚到上一版本（B6 后半）。

## 6. OpenAI 兼容接口（B4）

- 端点 `/v1/chat/completions`、`/v1/models`、`/v1/responses`（Core 已有翻译，见 chat/）。**现状**：由 `CORE_CHAT_TOKEN` 单一共享令牌保护，面向 LobeHub。
- B4 改造：
  1. 鉴权改为客户端令牌（`arc_`，scope `models:chat`）或账号会话令牌；`CORE_CHAT_TOKEN` 保留为所有者自用的兼容入口，过渡期后废弃。
  2. `/v1/models` 只列该用户可用的成员（别名 = 成员名），**不暴露 LiteLLM 内部模型名与 Key**。
  3. 请求按 user_id 路由：D117-19——每个用户的模型在 LiteLLM 里加用户前缀命名，由 Core 选择发往哪个模型；LiteLLM 免费版团队功能不够用就全靠 Core 隔离，结论写进 VERIFY.md。
  4. 限额与预算按用户分别计数；全量审计（模型名、token 数、结果，不记提示词与回复正文）。
- 标准协议，任何界面都能接，**不含任何界面专属代码**。

## 7. 实施顺序与完成标准

| 步骤 | 内容 | 完成标准（CI 必须覆盖） |
|------|------|--------------------------|
| B1a ✅ | 账号底座 | users.test.ts |
| B1b | 业务表 user_id 隔离，逐模块：成员（✅ 第一块）→ 设置 → 收件箱 → Key 记录 → 确认令牌 → 审计查询 | isolation.test.ts 每个模块加越权用例；`forUser` 模式；账号默认拒绝，放开一个模块写一组越权测试 |
| B2 | 保险箱 + 工具网关 | 加解密往返；篡改 aad 解不开；`VAULT_KEY` 缺失拒绝启动；无明文返回接口；SSRF 用例；恢复演练含保险箱 |
| B3 | 客户端令牌 + MCP 只读 | 吊销即时生效；范围外调用 = 不存在；全量审计；速率限制 |
| B4 | OpenAI 兼容鉴权与按用户路由 | 无令牌 / 错 scope 拒绝；`/v1/models` 不含他人成员；用量按用户计数 |
| B5 | MCP 调工具 | spend / danger 挂起等确认；超时作废；越权不可调用 |
| B6 | 公共记忆与交接包 | 交接包无密钥无他人数据；写入需人确认 |

## 7.1 B1b 剩余模块的实施顺序（不能乱，否则会留下越权口子）

已完成：成员、负责人设置（`forUser` / 键前缀视图，账号可用）；外部客户端令牌（B3 底座）；公共记忆（B6 首版，天然带 user_id）。

剩下三块**互相依赖**，必须按这个顺序，且在第 3 步完成之前**不得对账号用户或客户端令牌开放 `/v1` 对话**：

1. **确认服务支持账号**（D117-17）：现在 `ConfirmService` 的重新验证靠 Cloudflare Access（只认所有者）。账号用户的「重要确认」改为重新输入密码（`users` 已有 scrypt 哈希）；确认令牌的 actor 已是 `user:<id>`，可直接沿用。完成后账号才能做「删 Key」「彻底删除」等重要确认。
2. **收件箱按用户隔离**：`inbox_items` 加 `user_id`，去重索引改为 `(user_id, kind, related_type, related_id)`；`InboxStore.forUser`。**动作处理器（`registerHandler`）目前是所有者全局的**（例如 `member.candidate` 的入职会改所有者的成员）：隔离时处理器必须收到 `userId` 并只改该用户的数据，否则账号可以给自己发一张同 kind 的卡片去触发所有者的动作。账号用 `POST /api/inbox` 发卡片时 `kind` 只能是白名单里的。
3. **Key 记录 + LiteLLM 模型名前缀 + 对话按用户路由**（D117-19）：`provider_keys` 加 `user_id`；LiteLLM 里的对外模型名 = `u<hex>/<modelName>`（所有者仍用原名），`KeysService` 按用户加前缀、`key-reconcile`、`model-caps` 任务逐用户执行；`ChatService` 按调用者取成员、负责人，把成员名映射为带前缀的模型名发给 LiteLLM。**危险点：** 用户的成员叫 `Groq`，若对话层不加前缀就会转给所有者的 `Groq` 部署，等于花所有者的钱——所以第 3 步必须一次完成成员名→带前缀模型名的映射，并写一条越权测试「A 的成员名等于所有者的模型名时，请求仍只发往 A 自己的前缀模型」。

之后才做 B4（`/v1` 接受 `arc_` 客户端令牌与账号会话）。

## 8. 待负责人确认
1. D117-15 写「用 LobeHub 自带 Better Auth」；因界面可能更换，B1a 在 Core 层自建账号（见 PROGRESS）。
2. 所有者令牌的数据（`user_id='owner'`）并入所有者自己的账号的时机与方式。
3. PRODUCT 9.6 的 MetaMCP 在标准版缺席时，工具网关由 Core 最小实现（第 3 节）。
4. 外部 MCP 是否需要 OAuth（本文先用客户端令牌；多数桌面端 MCP 客户端支持自定义 Bearer 头）。
