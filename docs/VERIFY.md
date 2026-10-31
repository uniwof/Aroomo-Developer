# 一天验证 V1–V9（D189 第 4 节）

对象：AWS 测试机上的官方镜像 `lobehub/lobehub:2.2.20`（原样，不改不注入）。只读 Core，不改 LobeHub。
判定：V1、V2、V3 是硬条件，任一不过 → 改用 D181–D188 的 Open WebUI；其余不过用 D189 第 2 节对策，不换方案。

状态说明：**通过** = 已按通过标准实测；**静态通过** = 已在官方镜像内核实代码 / 配置，待界面实测补证；**待测** = 还没测。

| # | 验证什么 | 通过标准 | 状态 | 证据 / 结论 |
| --- | --- | --- | --- | --- |
| V1 | 自托管版有智能体群组、任务、外部智能体、执行设备，不需付费 Workspace | 四项都能在自托管版里打开 | 静态通过（待界面实测） | 镜像内有对应模块：群组 `builtin-tool-group-management` / CLI `lh agent-group`；任务 `builtin-tool-task` / `lh task`；外部智能体 `heterogeneous-agents`、`builtin-tool-claude-code` / `lh hetero`；执行设备 `device-gateway-client`、`builtin-tool-remote-device` / `lh connect`、`lh device`。是否被付费开关挡住要在界面里打开确认 |
| V2 | 群组里各成员保持自己的模型（issue 18246） | 3 个成员用 3 个不同 Core 别名，请求日志里也是 3 个不同模型 | Core 层通过；群组界面未证 | 2026-10-31 实测。①LobeHub API 密钥（保险箱「LobeHub API Key (aroomo-cli)」，经一次性填写页直填服务器 `/opt/aroomo/deploy/.lobehub-cli-key`，600，未经沙盒/聊天）能用：Core 容器内 `GET http://lobe:3210/api/v1/users/me` 200、tRPC `user.getUserState`（X-API-Key）200、不带密钥 401；官方 CLI `lh whoami` / `agent list` / `agent create` ×3 / `agent-group create` / `add-agents` 全部成功，建成群组「Aroomo M1 验收群」cg_ub49GudewEGN（成员 gpt-oss-20b→aroomo/openai-gpt-oss-20b、groq-oss120b→aroomo/groq-openai-gpt-oss-120b、gemini-38flash→aroomo/gemini-gemini-3-8-flash，Supervisor 自动建，模型 aroomo）。②Core /v1 三个成员别名各自到 LiteLLM 的不同模型：响应 model 字段 openai/gpt-oss-20b、groq/openai/gpt-oss-120b，gemini/gemini-3.8-flash 已到达 Google 但免费额度当天用完（429，每天 20 次）。③群组界面里成员智能体没有被单独调用：LobeHub 监督者（模型 aroomo）把所有发言都交给 Core，一个「主管」气泡回答，所以 issue 18246 的「各成员自己的模型」在界面里未证 |
| V3 | 群组里 @某成员只有它答；不 @ 由监督者分派（D31） | 两种情况都符合 | 路由通过；界面回答未通过（额度） | 2026-10-31 实测。Core 直调（model=aroomo）：不 @ → openai/gpt-oss-20b 回答并署名「— openai/gpt-oss-20b（负责人）」；@"groq/openai/gpt-oss-120b" → 该成员回答并署名；@gemini → 路由到 gemini，供应商 429。群组界面（新话题 tpc_abCeeT5wPeM6）：给 Core 成员加别名（gpt-oss-20b、groq-oss120b、gemini-38flash，与 LobeHub 智能体同名）后，@groq-oss120b → Core 转给 groq/openai/gpt-oss-120b，不 @ → 转给负责人 openai/gpt-oss-20b，都经 Core；**但回答失败**：LobeHub 群组每次请求约 2.2 万 token（LiteLLM 日志「TPM Limit 8000, Requested 22157–22626」），超出 Groq 免费档每分钟 8000，界面显示「暂时没有回应（额度用完或请求太频繁）」。另：群组里输入 @ 只弹「技能」菜单，没有成员选单，要手打名字；回复后监督者转圈不停，需点停止 |
| V4 | 任务定时触发并调用 Core MCP 的 create_task | 定时任务出现在 Core 任务队列 | 待测（依赖后台线 Core /mcp 与任务队列） | |
| V5 | 外部智能体（Claude Code 或 Hark）能作为成员接入 | 群组里能被分派任务 | 待测 | 官方 `lh hetero` 支持 Claude Code、Codex 等 CLI |
| V6 | 智能体头像接受外部图片地址（Core 生成的 SVG） | 能显示且能刷新 | 待测 | |
| V7 | Core /mcp 以连接器接入，并按用户区分 | 两个账号调用时 Core 能区分 | 待测（依赖后台线 Core /mcp） | |
| V8 | 有没有官方 API / CLI 批量创建、更新智能体和群组 | 有 → 自动同步；没有 → 导入模板 | 静态通过 | 官方 CLI `@lobehub/cli`（命令 `lh`，镜像内 apps/cli 0.0.66，npm 最新 0.0.72）有 `agent`、`agent-group`、`skill`、`task`、`topic` 子命令；登录方式为设备码或配置 API Key 服务器。npm 上未声明许可证（随 LobeHub 仓库许可），所以**只作为外部工具原样调用，不进我们的依赖树**（许可证闸门会拦）。D191 同步走「官方 CLI / 接口」档，不写 LobeHub 数据库 |
| V9 | 关掉知识库后是否还需要 pg_search | 记录结论 | 通过：**不需要** | 独立版（installer/standalone）早已用普通 PostgreSQL + `FTS_SEARCH_PROVIDER=pg_like` 跑官方 LobeHub，CI「构建离线安装包 + 静默安装 + 冒烟测试」每次都通过，即实测证据。镜像内迁移 `0090_enable_pg_search.sql` 在数据库没有 pg_search 时跳过，`0093` 的 BM25 索引同样跳过；全文检索由 `FTS_SEARCH_PROVIDER` 选择（`pg_search` 默认 / `pg_like` / `elasticsearch`）。启动守卫 `pgSearchGuard.js`：选了 pg_search 而库里没有会拒绝启动，所以换普通 PostgreSQL 时**必须同时设 `FTS_SEARCH_PROVIDER=pg_like`**。结论：按 D193「不需要」分支，LobeHub 与 Core 共用官方 PostgreSQL 17 实例、各用一个库，不需要 ParadeDB 例外。服务器版换库在迁甲骨文时按此配置 |

## 方法

- 静态核验：`docker exec aroomo-lobe-1` 只读查看官方镜像内的迁移、启动脚本与包目录（2026-10-29）。
- 界面实测（下一步）：在 Hark 沙盒里经 SSH 端口转发访问测试机上的 LobeHub，用官方 CLI 与 Hark 沙盒内的浏览器操作；**不在服务器上跑浏览器**。

## 语音开关（D68 / 所有者：无语音）

LobeHub 2.2.20 官方 FEATURE_FLAGS 里与语音相关的只有 `speech_to_text`、`voice_dictation`，服务器版已关（独立版早已关）。没有朗读（TTS）开关；LobeHub 里不填任何供应商 Key，OpenAI 朗读调用不通，但浏览器内置朗读入口仍可能显示——按 D190 不再用注入隐藏。

## 2026-10-31 实测小结（#191）

- 通过：LobeHub API 密钥可从 Core 与命令行调用；Core 的 @ 点名 / 不 @ 交负责人路由正确，群组界面的请求也确实经过 Core。
- 未通过：群组界面里看不到成员的回答。原因是免费额度装不下：LobeHub 群组一次请求约 2.2 万 token，Groq 免费档每分钟只给 8000；Gemini 3.8 Flash 免费档每天 20 次，当天已用完。
- 复测前要做（任选其一，不花钱优先）：①换一个每分钟额度大的免费模型当负责人和成员（例如 Gemini 额度恢复后或其他免费供应商）；②Core 在转给小额度模型前裁剪群组的长提示词与工具说明（改 core/src/chat，B/A 类工单）；③在 LobeHub 群组设置里关掉监督者的智能体模式减少提示词（只改设置，不改代码）。
- 不据此改用 Open WebUI：失败在模型额度，不在 LobeHub 群组本身（路由已通）。最终结论等复测。

## 结论（暂定）

- V8、V9 不阻塞；V9 去掉了对 ParadeDB（AGPL）的需要，不必再问所有者 ParadeDB 例外。
- V1 静态看齐全；V1 界面实测与 V2、V3 完成后在 DECISIONS 记最终结论（LobeHub 或 Open WebUI）。

- V1–V3 自动脚本：scripts/verify-d189.mjs（只读 GET）。无 LOBE_URL/LOBE_TOKEN 时 V1–V3 记「待测」并以退出码 2 结束，绝不当作通过；V3 为对话行为，需 CI 假模型界面测试。结论待全部实测后写入 DECISIONS。

- V8 同步脚本：scripts/lobe-sync.mjs（官方 CLI lh，环境变量 LOBEHUB_SERVER + LOBEHUB_CLI_API_KEY，不打印）。lh 能 agent create / agent-group create / add-agents；设置群组负责人（supervisor）没有 CLI 参数，需在 LobeHub 群组设置里选一次。Core /v1 目前只露出 aroomo 一个模型，@ 点名与负责人兜底由 Core 路由，所以 V3 现状是「一个 aroomo 智能体内 @ 成员→成员答，不 @→负责人答」；成员别名（aroomo/<名字>）等后台线露出后脚本自动改用。待 V2 令牌实测。
