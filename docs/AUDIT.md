# Aroomo 旧项目审计（AUDIT.md）

> 审计日期：2026-10-27（Asia/Shanghai）。只读审计：未推送、未改远程、未对 chat.pcmanai.com 发任何请求。
> 文中行号以旧仓库 uniwof/Aroomo 的 `repo/` 目录为准（与 bundle HEAD 的代码文件逐字节相同）。
> **本文不含任何真实密钥/令牌/密文。** 扫描方式：正则（gsk_/sk-/AIza/nvapi-/Telegram bot/ghp_/JWT/私钥/Bearer/`?k=` 等）+ 高熵串扫描，覆盖工作树、`work/`、两套 git 历史中的全部文本 blob。

## 0. 审查范围与版本

| 对象 | 内容 |
|---|---|
| 公开仓库 github.com/uniwof/Aroomo | 分支 main，HEAD `4b6acc57386be570d2fb8f6271a5de5a9a9c8907`；共 6 个提交（`afc4cf8`→`4b6acc5`，2026-10-26 21:57–22:30 +0800），全部是网页上传（"Add files via upload"），作者 uniwof。**没有 `.gitignore`**。 |
| Bundle `aroomo-main.bundle`（本地克隆后只读查看） | 只有 1 个引用 `refs/heads/main` = `7221f997cfb3f8274257066daf852cf79a27f283`；17 个提交（`a4e55e1` 2026-10-24 → `7221f99` 2026-10-25），线性历史，无其他分支/标签。关键提交：`003dee5`（P1-1）、`f5a7657`（L1）、`104eb2c`（P1-2）、`a0066ad`/`4382007`（P1-3）、`39e3aa9`/`50b3073`（P1-4）、`ab151eb`（P1-5，交接文档称"当前线上"）、`97b3cd0`/`9a9eaee`（P1-6，未上线）、`7221f99`（交接说明）。 |
| repo/ 与 bundle HEAD 对比 | 代码与文档逐字节一致（worker.js、page.html、caps.js、p1.js、toolgw.js、pwa.js、members.json、resources.json、deploy.py、bridge.py 等）。bundle 多出：`.gitignore`、`tests/`（caps.test.mjs、p1.test.mjs）、`test-output/`、`steward-test/`（含 `待用户决定.md`、`安全评审-groq-…md`、`实测记录.md`）、`ui-research/调研报告.md`、`wizardzines-借鉴.md`、`wz_contrast.py`、两张截图。**即公开仓库 = bundle HEAD 去掉测试与审计资料**。 |
| 交接文档称的部署包 | `work/deploy_prod.py` 还上传 `opskill.js`、`training.js`（部署时由 `skills/ai-groupchat-operator.md`、`docs-training/负责人培训手册.md` 生成），仓库里没有这两个生成物，属正常。 |
| 线上实际版本 | 无法核实（按要求不访问线上）。文档称线上 `ab151eb`，`9a9eaee` 待部署。 |

技术栈：单个 Cloudflare Worker（`worker.js` 2775 行，含路由、业务、DO 类）+ 一个 SQLite Durable Object `ChatStore`（`idFromName('main')`，**全站单实例单库**）+ Workers AI 绑定 + 每小时 cron `17 * * * *`；前端 `page.html` 1434 行单文件（内联 JS/CSS）；配置即数据：`members.json`、`resources.json`、`logos.json` 在部署时打包成 JS 模块。

---

## 1. 旧功能逐项去留表

建议用词：保留 = 概念和逻辑都要；移植 = 后端逻辑值得照搬/改写到新架构；合并 = 并入别的功能/入口；删除 = 不做；移入公共记忆 = 不给用户看，写给负责人/成员读。

| 功能 | 所在文件 | 建议 | 理由 | 对应 PRODUCT.md 章节 |
|---|---|---|---|---|
| 单一总令牌登录（`/?k=`、一年期 cookie、401 粘贴框） | worker.js `authKind` 155、`/?k` 1381-1386、`unauthorized` 164 | 删除（替换） | cookie 值就是 ACCESS_TOKEN 原文；令牌走 URL；所有派生密钥都绑在它上面。用账号/设备令牌体系替换 | 11.2 第 9 条（多设备登录）；0.4 |
| 退出登录 | worker.js `/logout` 1399 | 保留 | 基础功能，迁到设备管理 | 11.2 第 9 条 |
| 多设备登录（一次性链接+二维码、设备列表、踢下线） | 未实现（总纲 3.11） | 新做 | 用户已提需求 | 11.2 第 9 条；16（P6） |
| 左侧抽屉 5 入口 + 最近项目 | page.html | 合并 | "对话/项目/最近项目"重叠；按三层结构只留对话+收藏常驻 | 8.1、8.2、8.3（侧栏） |
| 顶栏全局搜索 | worker.js `search` 1226；page.html | 保留+扩展 | 用户 10-23 要求；扩到收藏/点子/成员 | 8.3（全局搜索） |
| 顶栏 Cloudflare 用量胶囊 | worker.js `usageView` 1340、`reqFlush` 1325、`/api/usage` 1633；page.html | 移入公共记忆（运维） | 后厨信息；只在影响可用时通知 | 8.4（要删掉的旧元素）；10.2 O3；9.10 |
| wizardzines 视觉风格 | page.html CSS | 删除（可重定） | 用户 10-26 允许重定；只保留 Logo、名称、额度圆环 | D2、D7；8.4 |
| 可访问性（19/21/23/25 字号、深浅色、减少动效、44px） | page.html 设置区 | 保留 | 用户眼疾，硬约束 | 8.4（缺口，见本文 P3） |
| PWA（manifest、图标、主屏幕） | pwa.js、worker.js 1368-1380 | 保留 | 说明文字改一次性提示；Windows 客户端另做 | 7.6；8.4 |
| 消息流（品牌头像+圆环+"模型名（角色）"+品牌色气泡） | page.html；worker.js `addMsg` 790 | 保留（重做样式） | 头像圆环是不可退让项 | 8.3（消息） |
| 名字旁"可用/不可用"文字小框 | page.html | 删除/合并 | 拥挤；圆环彩色/黑白已表达，读屏用 aria 文案 | D7、D12；8.4（头像） |
| 复制按钮 | page.html | 保留 | 基础 | 8.3（消息） |
| 朗读（TTS）+ 自动朗读 + 语速设置 | page.html 1243-1247、设置项 `agc-autoread`/`agc-rate` | 删除 | 用户 10-26 明确去掉 | D6、D12；8.4 |
| 语音输入（SpeechRecognition） | page.html 1248 | 保留 | 批准增强 ⑦"语音发任务" | 8.3（输入框）；D6 |
| @ 点名 | p1.js `parseMentions` 123；worker.js `startRound` 896 | 移植+增强 | 加候选弹出、按能力 @（@生图） | 8.3（输入框）；9.4；16（P2 按能力 @） |
| 5 种讨论模式（辩论/审查/自由聊/任务/主持） | worker.js `MODES` 27、`rolesFor` 685、`ROLE_BRIEF` 639；p1.js `MODE_INFO` 115 | 合并 | 用户只面对"我点名/交给负责人"；具体架构由负责人按任务类型选（总纲 §5.2-1） | D1；9.4 |
| 主持模式 + 快速建项目 | p1.js `quickLineup` 138、`hostPick` 142；worker.js `startRound` 852、900 | 移植 | 规则点名可复用为负责人托管兜底 | 9.4；9.3 |
| 暂停/继续 | worker.js `/api/room/:id/pause` 1592；`runTurn` 938 | 移植 | 已批准；补多标签页协同 | 9.4（对话操作）；10.2 B3 |
| 消息内决策按钮（ask/decide，幂等） | worker.js 1597-1613；p1.js `validateDecision` 148 | 移植 | 正是"只在需要拍板时打扰"；推广到通知中心 | 8.3（决策卡、接管卡）；9.9 |
| 再来一轮 | worker.js `startRound` 891 | 合并 | 发件箱补发后应自动触发，不再要用户点 | 9.4（对话操作）；10.2 B3 |
| 项目头"更多"菜单（成员与角色/打分/互评/路由记录/状态） | page.html | 合并 | 头部按钮散乱；打分/互评收尾自动弹；路由记录进审计 | 8.3（对话头部） |
| 阵容条 | page.html；worker.js `setLineup` 823 | 合并 | 并入项目信息，按需展开 | 8.3（对话头部 ⋯ 阵容与角色） |
| 协作过程透明（派活、审核意见、采纳） | 混在消息流（kind=lead/note） | 新做（结构化） | 核心需求，当前无"采纳/未采纳"结构、无折叠视图 | 8.3（协作过程）；9.4（意见台账） |
| 发件箱（IndexedDB→localStorage，cid 幂等） | page.html 721-726；worker.js `/api/start` cid 1634-1644 | 移植 | 已批准；修"补发后不自动回应" | 10.2 S4；7.4 |
| 新建项目弹层（议题/模式/勾成员/敏感/点子/快速建） | page.html 1001-1012；worker.js `startRound` 838 | 合并 | 新建=空对话；成员/敏感/点子做成轻量附加或自动判断 | 8.3（新建项目） |
| 敏感勾选（前端关键词自动勾） | page.html `SENS_RE` 1001；worker.js 868 只读 `body.sensitive` | 移植（改到服务端） | 判定应在服务端，且能事后修改 | 9.4、9.6；10.1 I17（缺口，见本文 P4） |
| 项目列表页（筛选状态） | page.html；worker.js `/api/rooms` 1571 | 合并 | 与最近项目合并为会话列表；补删除/排序/置顶/重命名 | 8.3（侧栏）；8.4（列表操作） |
| 项目状态手动下拉 | worker.js `/api/room/:id/status` 1618 | 删除（改自动） | 建议清单 D4 | 8.3（对话头部）；12（Project） |
| 删除项目 | worker.js `DELETE /api/room/:id` 1582 | 保留（补全） | 现只删 msgs/parts/tasks/ratings/rooms，残留 kv；且删 ratings 会改变成员口碑 | 8.4（列表操作）；16（P1） |
| 成员列表（筛选/排序/立即探测） | worker.js `/api/members` 1474、`enrichAll` 439；page.html | 保留（重做） | 开局为空，用户自己招人；探测改自动+节流 | 8.3（成员页）；9.1 |
| 预置 36 名成员 / 6 个中转站 / 26 个 Key 槽位 / 19 个工具 | members.json | 删除（产品默认）/ 迁移（用户实例） | 依赖 Hark 记忆预设；正式产品是空框架；但用户现有实例需迁移 | 3（空公司开局）；13 |
| 候选池（/v1/models 同步、归一化去重、确认入职） | caps.js `normModel` 16、`planModelSync` 112；worker.js `syncRelayModels` 341、`poolConfirm` 348、`candidates` 367、1541-1557 | 移植 | 核心逻辑正确，可直接复用 | 9.1（入职流程）；8.3（Key 与接入） |
| 一个模型一张卡、多来源、自动挑来源（在线→额度→免费） | worker.js `loadMembers` 322、`enrichAll` 439-470、`srcInvoke` 276、`srcMissing` 283 | 移植 | 已批准"来源轮换" | 9.1；5.2；12（Source） |
| 额度实查/估算（Groq 响应头、New API billing、官方免费额度） | worker.js `srcQuota` 374、`probeBalance` 551、`callOpenAI` rl 603 | 移植（结果移入公共记忆） | 圆环要用 pct；细节文字给模型看 | 9.2；9.10 |
| 每小时探测 | worker.js `probeAll` 501；`_scheduled` 1349 | 移植 | 改为可配置节流，控制 DO 调用 | 9.1（心跳）；10.1 I20 |
| 成员角色卡 5 标签页（简介/额度/历史/调用/接入） | worker.js `/api/member/:id` 1482-1500；page.html | 合并 + 移入公共记忆 | 用户侧只留头像圆环、名字、能力标签、一句话擅长、参与项目、启停删；其余进公共记忆 | 8.3（成员页）；9.10 |
| 社区评价标签（带出处） | members.json `tags`/`jobs` | 移入公共记忆 | 给负责人派工用 | 9.10 |
| 打分 + 互评 → 擅长/不擅长（≥2 次均分≥4/≤2） | worker.js `learnedTags` 473、`peerReview` 1190、`/rate` 1619 | 移植 | 已批准绩效评分；建议改为收尾自动轻量评分 | 8.3（评分）；11.2 第 7 条；10.1 I8 |
| 规则派工（岗位×额度×在线×厂商去重） | worker.js `TOPIC_JOBS` 667、`scoreMember` 700、`heuristicPlan` 728、`aiRefine` 744 | 移植 | 负责人不可用时的兜底 | 9.4；10.1 I8、I11 |
| 失败换人 | worker.js `replace` 995、`runTurn` 990 | 移植 | 已批准"自动接班"；用户只见一行"已由 X 接替" | 9.4（自动接班） |
| 添加外部成员（Poke/Webhook/Tailscale/Tunnel/Telegram/小桥/OpenAI 兼容/Hark/网页） | worker.js `CONNECTORS` 49、`saveAgent` 2156、`dispatchAsync` 1012；bridge.py | 移植（收进"高级"） | 能力需要，术语要藏起来 | 9.1（接入方式）；11.4 |
| Webhook 签名（HMAC 时间戳.正文） | worker.js `dispatchAsync` 1038-1041 | 移植 | 协议可沿用；缺接收端重放窗口说明 | 11.4 |
| 网页成员 + 代发员队列（领取锁、10 分钟改派、3 次、会话复用、签到、桌面需同意） | worker.js `webEnqueue` 1088、`webSweep` 1098、`webPull` 1119、`webReply` 1148、`relayAuth` 1081；p1.js `webPrompt` 11、`relayCanTake` 32、`webSweepPlan` 52 | 移植（执行端放 Windows 客户端） | 队列逻辑完整；执行端不在仓库 | 9.1.1；9.7；11.4 |
| 点子库（三态、关联项目、背景注入、结论回写、6 条预置） | worker.js 1164-1187、1667-1681；p1.js `validateIdea` 77、`ideaContext` 92、`IDEA_SEEDS` 105 | 保留 + 移植 | 用户需求；预置点子为用户个人数据，迁移而非作为产品默认 | D3；9.5；9.11 |
| 资源库·API 密钥（预设槽位、加密、验证、末 4 位） | worker.js 201-273、1410-1430；members.json `keys` | 移植（改为自定义） | 顶部一行新增；支持任意 OpenAI 兼容；**迁移时必须保住已填 Key** | 8.3（Key 与接入）；13 第 2 条 |
| 资源库·工具与算力（卡片写冷启动/额度/周期） | members.json `tools`；worker.js `toolsView` 2284 | 移入公共记忆 | 用户 10-26 推翻 10-23 的展示要求 | 9.6；9.10 |
| 工具网关（查网页、E2B、Daytona；付费/不可逆确认；每日上限） | toolgw.js；worker.js `gwFunctions` 2228、`gatewayCall` 2241、`confirmCall` 2306、`turnWithTools` 910 | 移植 | 安全模型对；修确认并发 | 9.6；10.1 I16 |
| 资源库·技能（148 条，Hark 导出） | resources.json `skills`；data/skills.tsv、recorded.tsv | 迁移（用户数据）/ 产品默认删除 | 依赖 Hark 记忆；对用户只展示标题 | 13 第 3 条（LobeHub Skills） |
| 资源库·学习与网站（44 条静态 + 管家入库 + 候选） | resources.json `sites`；DO `res_items` | 合并为"收藏"，前台常驻 | 就是总纲的收藏 | 9.5；8.3（收藏） |
| 资源管家（丢链接入库、抓正文、分类、官方页核实、去重、到期提醒、每周汇总、搜集羊毛、两档模型） | worker.js 1728-2130 | 移植（修核实逻辑）→ 扩为后台分工智能体之一 | 用户批准；"已核实"判定有缺陷（见 §4） | 9.5；9.8（缺口，见本文 P6） |
| 资源管家置顶私聊（兼通知中心） | worker.js `ensureStewardRoom` 1959、`STEWARD_ROOM` | 拆分 | 通知/审批独立成通知中心（红点） | 8.3（收件箱）；9.9 |
| 主负责人代收资源 submit_resource | worker.js `submitResource` 2077、`subClaim` 2076、`/api/steward/submit` 1445 | 移植 | 用户 10-24 需求；默认入库不追问 | 9.5（submit_resource） |
| 主/副负责人（A 内置大脑 / B 配对码）、超时接班、自动升主 | worker.js 2317-2514、2636 | 移植 | 核心需求 | 9.3 |
| 负责人资格判定（后端唯一） | caps.js `leadEligibility` 90 | 移植 | 逻辑正确 | 9.1（负责人资格）；9.3 |
| 配对码 + 操作员令牌 + 审计 | worker.js 2517-2655 | 移植（修并发、加过期） | 核心需求 | 9.3（缺口，见本文 P5） |
| 负责人岗位说明书（网页可改）+ 交接备注 + 状态快照 | worker.js `CHARTER_DEFAULT` 2659、`leadBrief` 2682、1518-1521 | 移入公共记忆 | 用户一般不看 | 9.3（培训激活）；9.10；10.1 I3 |
| 培训手册 + 复述激活 | docs-training/负责人培训手册.md；`/api/lead/ack` 1519 | 移植（加真正测验） | 现在只校验 ≥20 字，测验没执行 | 9.3（培训激活） |
| MCP 服务端（/mcp，33 个工具；文档写 21） | worker.js `MCP_TOOLS` 2713、`mcpHandle` 2748 | 移植 | 已批准"资源库开 MCP" | 9.3（对外 MCP）；9.5；11.2 第 10 条 |
| 操作技能文件 `/skills/ai-groupchat-operator.md` | skills/ai-groupchat-operator.md；worker.js 1366 | 移植（改写） | 接入说明 | 10.1 I3；9.3 |
| 敏感路由（中转站/公益站/公共接口/网页/外部 Hark 不发）+ 审计表 | worker.js `srcLevel` 2134、`routePolicy` 2144、`audit` 2145、`runTurn` 951-958 | 移植（补漏） | 已批准；有漏洞（见 §4） | 9.4、9.6；10.1 I17（缺口，见本文 P4） |
| 完成提醒（Bark/Telegram） | worker.js `notifyDone` 2146、`/api/notify/test` 1465 | 保留（简化） | 已批准 ⑦ | 9.9；D6 |
| Telegram webhook 设置 | worker.js `/api/telegram/setup` 1706、`/hook/tg` 1308 | 移植 | 路径由总令牌派生，需解耦 | 10.1 I4 |
| 测试模式（快照 kv、20 分钟后还原） | worker.js `testModeBegin/End` 805-822、`/api/testmode` 1440 | 删除（产品内）/ 改为独立测试环境 | 在生产库里做测试；还原会覆盖用户真实改动 | 15.2 |
| `/api/probe-model`（任意 @cf 模型试调） | worker.js 1712 | 删除 | 调试接口，耗额度 | — |
| v1 旧房间兼容（LEGACY 阵容映射） | worker.js `LEGACY` 775、`normMsg` 778 | 迁移时一次性转换后删除 | 历史包袱 | 13 |
| 主负责人私聊入口 | — | 删除（已取消） | 用户 10-23 15:59 取消 | D6、D12；8.4 |
| 备用入口（第二 CF 账号暂存队列） | docs/P1-6-备用入口方案.md（未实现） | 视新架构决定 | 依赖免费版限制；新架构若换存储可不需要 | 7.4；10.2 O4 |

---

## 2. 旧数据清单

> 线上数据库的真实行数**无法得出**（按要求不访问线上，DO 数据也不在仓库/bundle 中）。下面给出：①仓库里的静态/预置数据的确切条数；②线上存储位置与格式；③能从文档推断的情况。迁移前需在线上用只读导出脚本取数。

### 2.1 存储总览
- 唯一数据库：Durable Object `ChatStore`（SQLite 后端），`env.DB.idFromName('main')` 单实例（worker.js 125），表结构在构造函数里 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` 补列（worker.js 72-114）。没有 D1（总纲 §8 写"+ D1"与代码不符）。
- 配置类数据随代码部署：`members.json`、`resources.json`、`logos.json`、`skills/*.md`、`docs-training/*.md`（打包为 JS 模块）。
- 浏览器本地：`localStorage`（`agc-outbox`、`agc-theme`、`agc-fs`、`agc-rm`、`agc-rate`、`agc-autoread`、`agc-usage-warned`）与 IndexedDB `aroomo-outbox`（未发出的消息原文）。
- Worker secrets：ACCESS_TOKEN、各外部 Key、TELEGRAM_BOT_TOKEN、AGENT_*（值在 Cloudflare，仓库无）。

### 2.2 各类记录

| 类别 | 静态/预置条数（仓库） | 线上存储位置与格式 | 备注 |
|---|---|---|---|
| 成员 | `members.json.members` **36** 条（其中 2 条 retired：gemma-3-12b、cf-paid-only），共 55 个来源（openai 18、workers-ai 13、selfhost 11、bridge 4、image-openai 2、gemini/poke/webhook/web/lead/steward/none 各 1）；能力状态 verified 7 / pending 27 / n/a 2 | 预置：members.json（部署时打包）。用户自建/配对/候选池确认的成员：DO 表 `custom(id TEXT PK, json TEXT, created INTEGER)`，整张成员卡存 JSON。自定义负责人端点：伪成员 `lead-p`/`lead-s`，由 kv `lead_cfg` 动态生成 | 线上 `custom` 行数未知；文档提到线上有测试成员"测试甲/乙/丙"需清理。HANDOFF 写"35 张卡"、代码为 36（文档漂移） |
| 成员能力覆盖 | — | kv `caps:<memberId>`（JSON） | 用户核实能力写这里 |
| 来源同步/候选池 | — | kv `model_pool`（数组，≤500）、`model_extra`（对象）、`model_pool_dismissed`（≤1000）、`relay_models:<relay>`、`relay_balance:<relay>` | |
| 成员状态/用量/评分 | — | 表 `status(member PK=成员@来源序号, state, checked, err, info JSON)`；`usage(member, day, calls, tin, tout, neurons)`；`ratings(id, room, member, job, score, src, rater, note, ts)`；`calls(...)` 调用记录（含工具待确认 ok=2） | `status/usage` 的 key 依赖来源**序号**，members.json 来源顺序一变，历史就错位 |
| 技能 | `resources.json.skills` **148** 条（已安装 130、只记录 18）；源 `data/skills.tsv`（131 行含表头/分组行）+ `data/recorded.tsv`（19 行），由 `data/build_resources.py` 生成 | 只读静态（打包），线上无表 | 内容来自 Hark 自己的技能列表 |
| 网站 | `resources.json.sites` **44** 条（未核实 33、已核实 10、已过期 1），源 `data/sites.py` | 静态 44 条 + DO 表 `res_items`（管家入库条目，id 前缀 `u-`链接/`t-`纯文本/`c-`候选；含 via/via_by/via_note/via_src/test 列） | 附录 A 与截图写 45，可能是 44 静态 + 1 条 res_items；线上 `res_items` 行数未知 |
| 代收记录 | — | 表 `subs`（最多保留约 200 行，subLog 自动删旧） | |
| 点子 | `p1.js IDEA_SEEDS` **6** 条（seed-photo、seed-prompt、seed-guofeng、seed-laser、seed-newterm、seed-pcman） | 表 `ideas(id, title, thought, plan, expect, summary, source, tags JSON, status, created, updated, notes JSON)`；kv `ideas_seeded` 标记已播种；`rooms.idea` 关联 | 首次读点子时把 6 条预置写进库；用户后来新增/修改数量未知。预置点子含用户个人商业想法与域名 |
| 项目 | — | 表 `rooms(id, title, mode, created, updated, members JSON, status, sens, idea)`；消息 `msgs(id, room, kind, member, model, text, ts, role, test)`；参与 `parts`；任务 `tasks(... kind, relay, claimed, attempts, ext JSON)`；kv `room_lead:<room>`、`pause:<room>`、`decision:<msgId>`、`leadwait:<room>`、`websess:<room>:<member>`、`cid:<cid>` | 线上数量未知；含固定置顶房间 `steward`；文档称有重复测试项目、v1 旧房间未找到 |
| 审计日志 | — | 两张表：`audit(id, room, member, via, level, action, note, ts)`（敏感路由 used/blocked）；`opaudit(id, ts, member, method, path, note)`（操作员每次请求、配对、吊销、升主、候选确认） | 线上行数未知。交接要求"清测试数据时不得删审计日志"。注意：删除项目**不删** audit，属正确 |
| 负责人/令牌配置 | — | kv `lead_cfg`、`op_tokens`（{memberId:{hash,name,created,active,ack}}）、`lead_charter`、`handoff_note`、`lead_ack:<member>`、`pair:<code>`、`pairrl:<ip>:<minute>`、`web_relays`、`route_policy`、`notify` | |
| 其他运行状态 | — | kv `reqs:<day>`、`dos:<day>`、`reqwarn:<day>`、`steward_calls:<day>`、`steward_vcalls:<day>`、`steward_*`、`cf_exhausted`、`last_probe`、`testmode`、`sub_busy:<id>`、`webcheckin:<member>:<day>`、`lead_inelig_note:<slot>` | 部分键（`pairrl:*`、`steward_calls:*`、`webcheckin:*`）无清理任务，会无限增长 |
| API Key | `members.json.keys` 26 个槽位（24 个有环境变量名，2 个免 Key，1 个账号绑定） | 表 `apikeys(name PK, iv, ct, last4, saved, vstate, vmsg, vat)` | 见 2.3 |

### 2.3 API Key 存储与加密机制（只描述机制）

- **位置**：DO SQLite 表 `apikeys`，一行一个变量名（如 GROQ_API_KEY、E2B_API_KEY、BARK_KEY，以及自定义负责人端点的 `LEAD_P_KEY`/`LEAD_S_KEY`）。列：`iv`（base64 的 12 字节随机 IV）、`ct`（base64 密文，含 GCM 认证标签）、`last4`（**Key 明文末 4 位，明文存储**）、`saved`、验证状态 `vstate/vmsg/vat`。写入在 `ksPut`（worker.js 212），读出在 `ksAll`（218）。
- **算法**：AES-256-GCM（WebCrypto），每条随机 96 位 IV；**附加认证数据（AAD）= 变量名**（防止把一条密文挪到另一个来源下）。
- **密钥派生**：`ksKey`（worker.js 206）：`AES 密钥 = HMAC-SHA256(key = ACCESS_TOKEN 的 UTF-8 字节, msg = "agc-keystore-v1")`，得到 32 字节直接作为 AES-256 原始密钥。无盐、无 KDF 迭代、无密钥版本号。
- **主密钥来源**：Worker secret 绑定 `ACCESS_TOKEN`（`env.ACCESS_TOKEN`，长度须 ≥32）。原部署脚本从 Hark 沙盒私有文件 `/workspace/storage/secrets/ai-groupchat.json` 读取后作为 `secret_text` 上传（`work/deploy_prod.py` `load_secrets`）；该文件**不在交接包**。Cloudflare secret 只写不可读。
- **取值优先级**：Worker 同名 secret 优先，DO 里的密文其次（`withKeys` 228）；且只合并 members.json 声明过的变量名和 LEAD_P/S_KEY。
- **解密所需条件**（三者缺一不可）：
  1. DO `apikeys` 表的 `iv`、`ct`、`name` 三列（只能由同一 Cloudflare 账号下绑定该 DO 的 Worker 读取，或经 Worker 内导出接口）；
  2. 当时使用的 **ACCESS_TOKEN 原值**（用户本人持有登录链接中的 `k` 值，或原 Hark 私有文件）；
  3. 变量名作为 AAD。
  → 可行迁移路径：在旧 Worker 内（代码已有 `ksAll`）加一个仅 cookie + 一次性确认的导出接口，在 Worker 进程内解密后用**新系统的公钥/新密钥**重新加密再导出；或让用户提供 ACCESS_TOKEN 后离线解密。不要让明文离开 Worker 内存或进入聊天。
- **风险**：①改 ACCESS_TOKEN = 所有 Key 立即无法解密，`ksAll` 的 `catch {}` 会**静默吞掉**失败，界面表现为"未填"而不是"解密失败"；②同一个 ACCESS_TOKEN 同时派生成员令牌、代发员令牌、操作员令牌哈希、Telegram webhook 路径；③cookie 里存的就是 ACCESS_TOKEN 原文，拿到 cookie = 拿到解密主密钥（再加 DO 读权限即可解密全部 Key）；④`last4` 明文存储（按设计，影响小）；⑤每个已登录的 API 请求都会 `withKeys` → 把全部 Key 解密一遍到内存（1431 行），增加暴露面和 CPU。

### 2.4 泄密检查结论
- **未发现真实密钥/令牌/密文**（工作树、`work/`、两套 git 历史所有文本 blob）。`test_live.py` 第 72 行的 Bearer 值是刻意的错误令牌（以 wrong- 开头），不是泄漏。截图 `shots/*keys*.png` 抽查为空输入框，未见 Key。
- **发现的敏感标识（非凭据，但不应公开）**：
  - `work/deploy_prod.py` 第 15、16、24 行：Cloudflare 主账号 Account ID、Zone ID、第二个（临时测试）账号 Account ID（已脱敏，未复制）；第 7 行出现第二账号的用户名，第 143 行出现其 workers.dev 子域名。
  - `work/backup_live.sh` 第 5 行：主账号 Account ID（已脱敏）。
  - 主账号邮箱、用户真实姓名出现在多个文档（开场说明、HANDOFF）；git 提交作者邮箱公开。
  - `work/*.sh`、`test_live.py`、`ui_test.py` 写死 Hark 沙盒令牌文件路径 `/workspace/storage/secrets/ai-groupchat.json`（只是路径，不含值）。
  - 这些都在**公开 GitHub 仓库**里。账号 ID 本身不是凭据，但与邮箱/子域组合便于定向钓鱼和 API 枚举，建议从公开仓库移除并改私有。

---

## 3. 需移植的后端逻辑

工作量：S ≤1 人天，M 2-3 人天，L ≥4 人天（含测试，不含 UI）。

### 3.1 配对码
- 文件/函数：worker.js `PAIR_ALPHA` 2519、`pairCode` 2522、`pairPhrase` 2550、`pairNew` 2564、`pairStatus` 2574、`pairRedeem` 2582；路由 `/api/pair/new` 1523（cookie 或操作员）、`/api/pair/status` 1524、`POST /api/pair` 1362（**免登录**）。
- 机制：服务器用 `crypto.getRandomValues` 生成 8 位（32 字符表，去掉易混字符，约 40 位熵），格式 `XXXX-XXXX`，存 kv `pair:<code>` = {slot p/s, exp=10 分钟, state=waiting, by}。生成新码会把所有 waiting 码置为 void，并顺手删 1 小时前过期的码；写 opaudit（码只记前 2 位）。兑换：按 `cf-connecting-ip`+分钟限速 8 次/分钟 → 校验格式与 waiting/未过期 → 置 used → 新建配对成员 `x-agent-<6位随机>`（paired:true，来源 kind=pair）→ 写 `lead_cfg[slot]` → 删除被替换的旧配对成员（其成员令牌随之失效）→ 返回成员令牌 + 拉取/回复地址 + 中文接入说明；同时生成操作员令牌（见 3.2）。不调用任何模型。
- 移植要点：改成原子"条件更新"兑换（现为读-改-写，存在双兑换竞态）；限速键需过期清理；不再从 ACCESS_TOKEN 派生成员令牌；码与令牌绑定到具体账号/工作区（多用户化）。
- 工作量：**M（2 人天）**。

### 3.2 操作员令牌
- 文件/函数：worker.js `pairRedeem` 2607-2615（发放）、`opTokens` 2620、`opPrune` 2622、`opAuth` 2627、`opDeny` 2647、`opLog` 2655、`OP_SCOPE`/`OP_DENY` 2520-2521；鉴权入口 1387-1394；吊销 `/api/operator/revoke` 1516（cookie）；查看 `/api/operator` 1515；激活 `/api/lead/ack` 1519；MCP 复用 `mcpHandle` 2752。
- 机制：令牌 `op_` + 48 位 hex（192 位随机）；只存 `HMAC-SHA256(ACCESS_TOKEN, "op:"+令牌)` 到 kv `op_tokens[memberId]`，初始 `active:false`。鉴权：格式正则 → 计算 HMAC → 遍历比较 → 该成员必须仍是当前主/副负责人，否则无效。权限：`opDeny` 黑名单（任何 DELETE、`/api/keys*`、`/api/tools/confirm`、`/api/operator*`、`/api/guide/*`）+ 副负责人只能 GET（及 ack）+ 未激活只能读 brief/ack；各接口内部再有 cookie-only 检查（密钥、吊销、能力核实、代发员、说明书、模型同步等）；`leadSave` 禁止操作员新建/修改自定义端点地址和写 Key；`saveAgent` 禁止操作员改已有成员或引用密钥。每个请求（含被拒）写 opaudit。负责人更换时 `opPrune` 作废不在位令牌。
- 移植要点：改为**白名单**权限模型（现为黑名单，新接口默认对操作员开放，例如 `/api/settings` 可关掉敏感路由）；加过期时间与轮换；令牌哈希不依赖 ACCESS_TOKEN；激活改为真正的测验。
- 工作量：**M（3 人天）**。

### 3.3 负责人资格判定
- 文件/函数：caps.js `capsOf` 34、`validateCaps` 51、`leadKind` 76、`leadEligibility` 90、`leadNotice` 142、`isReservedId` 10、`isPairedMember` 12、`LEAD_MIN_CTX=32000` 6；worker.js `leadMemberOf` 2328、`leadUsable` 2334、`leadText` 2342、`leadPlan` 2379、`leadDispatch` 2410、`leadCheck` 2419、`leadView` 2443、`leadCandidates` 2452、`leadIneligibleNotice` 2459、`leadSave` 2464、`leadTest` 2506、`promoteSecondary` 2636；能力核实接口 `/api/member/:id/caps` 1531（cookie only）。
- 机制：成员分 builtin / paired / agent / custom-endpoint / model 五类。builtin（Hark 规则、资源管家）不可当；paired、agent、自定义端点凭接入获资格；model 类必须同时满足 tags 含 chat、context_window ≥32000、tool_call===true、capability_status==='verified'（verified 必须写来源），未知一律不合格；网页成员、生图/视频/语音专用成员不合格。保存时服务端先整体校验，不合格 400 且不改动；运行时不合格不静默替换，按"主→副→内置规则"接任并在资源管家私聊提醒一次。外部负责人走异步任务，超时（20-1800 秒，默认 180）由 GET 房间/cron 触发 `leadCheck` → 交副负责人、可能自动升主。
- 移植要点：纯函数部分（caps.js）可直接搬，附带现成单测 `tests/caps.test.mjs`（bundle 内）；超时检查改成真正的定时器/队列而不是"GET 时顺便检查"。
- 工作量：**S（caps.js 纯函数 1 人天）+ M（接任/超时/升主流程 2-3 人天）**。

### 3.4 敏感路由
- 文件/函数：worker.js `LEVELS` 2133、`srcLevel` 2134、`routePolicy` 2144（默认 blockRelay:true；blockTools/blockHark 未设时视为开）、`audit` 2145、`runTurn` 951-958 与 984-988、`leadUsable` 2337、`leadText` 2347、`gatewayCall` 2257-2261、`notifyDone` 2150（敏感项目推送不带标题）；设置接口 `/api/settings` 1458-1464；房间标记 `rooms.sens`（`startRound` 868 取自请求体）；前端关键词 `page.html SENS_RE` 1001。
- 机制：每个来源按 invoke 推出级别 official / relay / public / web / agent / builtin。敏感项目：relay、public、web 来源一律跳过并写 audit(blocked)；kind 为 hark/pair 的外部智能体默认跳过；第三方工具默认不调；被拦且无其他来源时在房间说明而不是静默换源；用到的来源写 audit(used)。
- 已知缺口（详见 §4）：`agent` 级别中的 poke / webhook / telegram / tailscale / tunnel / bridge **在敏感项目里不拦**；敏感判定只在前端；项目建好后不能改敏感；操作员可经 `/api/settings` 关闭全部限制。
- 工作量：**M（2 人天，含服务端敏感词判定、策略白名单化、补 agent 级别规则）**。

### 3.5 资源管家核实规则
- 文件/函数：worker.js `safeUrl` 186（SSRF：仅 https、拒 IP 私网段/localhost/内部后缀/IPv6/本站）、`safeFetchText` 1763（每跳重验、≤4 次重定向、10 秒、600KB）、`readLink` 1780（X 帖走 fxtwitter，失败明说不补）、`ruleCat` 1794、`ruleExtract` 1803、`STEWARD_SYS` 1815、`stewardSmallChain` 1819/`stewardSmall` 1827（小档：Groq gpt-oss-20b → PM 公益站 glm-4.5-flash → Workers AI，日上限 60）、`strongEligible/strongScore/strongRank` 1740-1753（强档：当天最强免费成员，写死初判分表 `STRONG_BASE` 1735，日上限 20）、`stewardStrong` 1847、`VERIFY_SYS` 1875、`verifyTiered` 1889、`resState` 1910、`ingestLink` 1911、`ingestText` 1918、`ingestPage` 1923、`urlKey/sha` 1760-1761（去重 id）、`submitResource` 2077 + `subClaim` 2076（10 分钟原子占位）、`gatherDeals` 2108（HN+linux.do，只进"候选"）、`expiryCheck` 2015（英国时间 8 点后每日一次，7 天内到期）、`stewardWeekly` 2042（周一 8 点）、`stewardMessage` 1994（≤3 链接/次；无链接则双字分词检索 `searchRes` 1976）。`verifyOnOfficial` 1879 为**死代码**（未被调用）。
- 机制：抓正文 → 模型（或规则）抽取 {分类、名称、用途、免费额度、到期、证据原句、官方网址、是否付费} → 取候选"官方页"（网页类=提交的页面本身+模型给的官方网址；帖子类=模型给的官方网址+帖子内链接；排除社交/论坛域名）中第一个能打开的 → 强档模型读官方页给出原句 → **原句（规范化后前 90 字，≥8 字）必须在页面正文中逐字出现**才标"已核实"，否则回退规则：抽取阶段的证据原句是否在页面中出现；都不行标"未核实"。过期按英国日期判。按 URL 规范化 SHA-256 前 16 hex 做幂等 id，重复提交是 upsert。
- 缺陷：对网页类链接，"官方页"就是被提交的页面本身，证据也取自该页 → 只要有证据原句就必然"已核实"（自证）；"官方"仅等于"不在社交域名黑名单"。新系统需要真正的官方域名判定（厂商域名表/用户确认）。
- 工作量：**L（4-5 人天，含修核实逻辑、计数原子化、改为后台任务队列与重试）**。

### 3.6 其他值得一并移植的逻辑（参考）
| 逻辑 | 位置 | 量级 |
|---|---|---|
| Key 加密存储 + 当场验证（多种验证方式 bearer-get/xkey-get/goog-get/kaggle/bearer-chat） | worker.js 201-273 | S（换密钥体系 M） |
| 模型同步/候选池 | caps.js 16、112；worker.js 341-371 | S |
| 来源挑选与额度计算 | worker.js 374-470 | M |
| 代发队列 | worker.js 1075-1161；p1.js 11-73（有 `tests/p1.test.mjs`） | M |
| 工具网关 + 付费确认 | worker.js 2222-2315；toolgw.js | M |
| MCP 映射 | worker.js 2710-2775 | S |
| 发件箱 cid 幂等 | worker.js 1634-1644 | S |
| DO 会话复用（P1-6 fix1，AsyncLocalStorage + RpcTarget） | worker.js 119-135 | 仅当继续用 DO 时 S |

---

## 4. 旧代码已知缺陷和坑

### 4.1 安全
1. **总令牌即 cookie**：cookie `agc` 的值就是 ACCESS_TOKEN 原文（worker.js 1384）。它同时是：网页登录凭据、Bearer 凭据、Key 库 AES 密钥的派生源（206）、成员令牌派生源（176）、代发员令牌派生源（1079）、操作员令牌哈希密钥（2610、2629）、Telegram webhook 路径与 secret（177）。任一处泄露 = 全部失守；任一处轮换 = 全部失效（含 Key 库静默丢失）。
2. **令牌走 URL**：`/?k=<令牌>` 登录（1381），会进浏览器历史/书签/截图/代理日志；`work/deploy_prod.py` 还把 `login_link` 存进秘密文件。
3. **无会话过期/无多设备/无吊销**：cookie 一年有效；改令牌是唯一的"踢下线"方式。
4. **成员/代发员令牌是确定性 HMAC，不可单独吊销**：删除后用同 id 重建（自建成员 id 由用户自选 `x-…`；代发员 id 自选）会得到**同一个令牌**（worker.js 176、1079、saveAgent 2156、relays 1687-1695）。
5. **操作员权限是黑名单**（`opDeny` 2647）：新增接口默认对操作员开放。现有越权面：`POST /api/settings`（1459）可把 `route_policy` 的 blockRelay/blockTools/blockHark 全部关闭 → 敏感项目内容可被发往中转站/公益站/外部智能体；还可调 `/api/probe`、`/api/probe-model`、`/api/telegram/setup`、`/api/plan` 等耗额度接口；可经 `/api/lead` 把负责人换成任意合格成员、经 `/api/pair/new` 为任意第三方生成配对码（设计如此，但无用户确认）。
6. **敏感路由漏洞**：`runTurn` 只拦 relay/public/web 级别和 hark/pair 两种 kind（956-957），**poke、webhook、telegram、tailscale、tunnel、bridge（级别 agent）在敏感项目里照常发送**完整提示和聊天记录（`dispatchAsync` 1019 payload 含 system/prompt/transcript）；Poke、Telegram 都是第三方服务。敏感判定只在前端（page.html 1001），API/MCP 调用方不传 `sensitive` 就不敏感，且建好后无接口修改 `sens`。
7. **"master Bearer" 与 cookie 权限不一致**：用 ACCESS_TOKEN 作 Bearer 时（kind=bearer）不能写 Key/确认付费，但能 DELETE 房间/成员、决策拍板；MCP 也接受 ACCESS_TOKEN（2752），持有者通过 MCP 也走 bearer 路径。权限矩阵分散在各路由里，无集中表。
8. **GET 有副作用 + SameSite=Lax**：`GET /api/members` 会触发 `probeAll` 写库（1476）；`GET /api/room/:id` 会执行 `webSweep`、`leadCheck`（可能失败任务、改阵容、自动升主）（1575-1576）。审计文档声称"GET 不改数据"不成立；跨站顶级导航可携带 Lax cookie 触发这些 GET。
9. **配对兑换非原子**：`pairRedeem` 先 `kvGet` 再 `kvSet(state:'used')`（2591-2593），两次 RPC 之间可交错，注释称"防并发重复兑换"但未用条件更新；限速计数同样是读-改-写（2585）。
10. **付费工具确认可重复执行**：`confirmCall` 先 SELECT ok=2 再 UPDATE（2307-2311），双击/重放可让付费或不可逆动作执行两次。
11. **回调写回非原子**：`completeTask` SELECT 后 UPDATE（1059-1061），同一任务并发 `/hook/reply` 可能写两条回复；`/bridge/pull` 也是先查后改（1289-1290），同一成员两个拉取端可能领到同一任务。（代发队列 `webPull/webReply` 用了条件更新，是正确写法。）
12. **资源管家"已核实"可自证**（3.5）：网页类链接的"官方页"就是被提交的页面，任意第三方页面都能把自己的说法标成"已核实"；"官方"只是"非社交域名"。资源库被所有成员当作事实来源，存在投毒/错误传播风险。
13. **提示注入面**：网页正文、帖子、外部成员回复都直接进入其他模型的上下文；`bridge.py`（`--cmd "claude -p"` 等）把群聊提示原样交给本机有工具权限的智能体（bridge.py 30-33），群里任何内容都可能变成对用户电脑的指令；工具网关允许模型自主 `fetch_url`/`run_code`（910-929）。点子背景有防伪分隔符处理（p1.js `ideaContext`），其他输入没有。
14. **SSRF 防护只看字面主机名**：`safeUrl` 不解析 DNS（186-198）；在 Cloudflare Workers 上风险较低，但移植到自建服务器/Windows 客户端时**必须**加解析后 IP 校验，否则可访问内网。
15. **CSP 允许 `'unsafe-inline'` 脚本**（1402）：前端大量 `innerHTML` 拼接（约 48 处），目前多数经 `esc()`，但任何一处漏转义就能执行脚本并读取 API（cookie 为 HttpOnly，但同源请求可直接调用）。
16. **公开仓库暴露运维标识**：Cloudflare Account/Zone ID、第二账号用户名与子域、主账号邮箱、用户姓名（见 2.4）；公开仓库也缺 `.gitignore`（bundle 里有），以后误传 `.dev.vars`/secrets 的风险高。
17. **测试脚本默认打线上**：`test_live.py` 14 行、`ui_test.py` 12 行默认 `AGC_BASE=https://chat.pcmanai.com`，并默认读取令牌文件；忘记设环境变量就会对生产跑全量测试（曾因此把 DO 免费额度用穿）。

### 4.2 并发与数据完整性
1. **单 DO 单库**：全站所有读写串到一个 Durable Object（125）；无法多用户、无法水平扩展；免费版每天 10 万次请求为全账号共享上限（已出过事故）。
2. **计数器非原子**：`steward_calls/vcalls`（1835、1854）读-改-写；`kvSet` 覆盖整份 JSON 对象（`op_tokens`、`web_relays`、`lead_cfg`、`model_pool`）存在丢更新。
3. **测试模式在生产库里还原快照**：`testModeEnd`（811-822）把 `lead_cfg`、`op_tokens`、`route_policy`、`notify`、`model_pool` 等 12 个 kv 键**覆盖回 20 分钟前的快照** → 测试窗口内用户真实改动（换负责人、吊销令牌、改敏感策略）会被悄悄回滚，吊销的操作员令牌会"复活"。测试建的项目/成员不清理（文档承认线上有测试数据）。
4. **删除项目副作用**：删 `ratings`（1583）会改变成员口碑统计；`room_lead:*`、`pause:*`、`decision:*`、`leadwait:*`、`websess:*` 残留；`audit` 保留（正确）。
5. **删除成员不检查是否在任负责人**（1705），删后负责人槽位"未设置"；房间阵容里残留已删 id。
6. **状态/用量按"成员@来源序号"记**（`skey` 303）：members.json 来源顺序变化或删来源会让历史错位。
7. **kv 无限增长**：`pairrl:*`、`steward_calls:*`、`steward_vcalls:*`、`webcheckin:*`、`pair:*`（仅在生成新码时清理）没有定期清理；cron 只清 `cid:*`、`reqs:*`、`dos:*`、`reqwarn:*`（1349）。
8. **全量读取**：`getRoom` 每次轮询读整个房间所有消息再在内存里按 `after` 过滤（784、1578）；`enrichAll` 每次请求重建全部成员视图；`withKeys` 每个请求解密全部 Key。
9. **ALS 会话失败不重试**（131）：一次 DO 会话打开失败，整个请求内所有查询都失败。
10. **readBody 不接受 JSON 数组**（1249），因此 MCP 批量请求实际不可用（`mcpHandle` 2755 期待数组）。
11. **静默吞错**：`ksAll` 解密失败 `catch {}`（223）；大量 `ctx.waitUntil(...catch(() => {}))`，后台失败无日志（且 observability 关闭）。
12. **时区混用**：到期/签到/汇总用 `Europe/London`（1758），用量/额度用 UTC；用户在中国（Asia/Shanghai），日期边界会差 7-8 小时。
13. **v1 遗留**：`LEGACY` 阵容映射、无 `members` 列的旧房间兼容逻辑（775-778）。

### 4.3 部署
1. **两个部署脚本都整包替换绑定**：`deploy.py` 102-111 与 `work/deploy_prod.py` `put_script` 都上传完整 bindings 列表，**没有 `keep_bindings`**；不带全部 secret 值上传会清空线上外部 Key、TELEGRAM_BOT_TOKEN、AGENT_*，ACCESS_TOKEN 若换值则所有派生令牌与 Key 库失效。
2. **仓库 `deploy.py` 缺 `compatibility_flags: ["nodejs_als"]`**（112 行 meta），而 worker.js 第 6 行 `import 'node:async_hooks'` → 用仓库脚本部署会失败/报错；只有 `work/deploy_prod.py` 加了。`wrangler.toml` 也没有 `compatibility_flags`、没有 `[ai]` 绑定，本地 `wrangler dev` 依赖未入库的 `run_local.sh`。
3. **`work/` 脚本写死原沙盒路径**：`/workspace/projects-src/ai-groupchat`、`/workspace/work/p1-rest/…`、`/workspace/rb/socks/…`、`/workspace/work/vltest/cfapi.sh`、`/workspace/storage/…`，依赖自建 SOCKS 代理；`killp.sh` 会 `pkill -f workerd`。
4. **硬编码域名**：`chat.pcmanai.com` 写死在 `safeUrl` 196、`dispatchAsync` 1016、`notifyDone` 2151、bridge.py 46、测试脚本默认值、deploy guard。
5. **无迁移版本管理**：表结构靠构造函数里的 `CREATE IF NOT EXISTS`/`ALTER TABLE`，每次 DO 冷启动都执行 PRAGMA；无回滚脚本；`calls` 表还在构造函数里跑数据修正 UPDATE（114）。
6. **配置即代码**：成员、Key 槽位、中转站、工具、技能、网站都在 JSON 里随代码部署，用户改不了（与"空框架、用户自己招人"相悖）。
7. **observability 关闭**（deploy 脚本 meta）：线上出错只能靠复现。
8. **本机测试基线 4 项固定失败**（空库），容易掩盖回归。

### 4.4 文档与实现不一致（迁移时以代码为准）
- 总纲称"Durable Objects + D1"，代码只有 DO SQLite。
- HANDOFF/README 称 MCP 21 个工具，代码 `MCP_TOOLS` 有 33 个。
- HANDOFF 称 35 张成员卡，members.json 有 36 条。
- 附录 A 称 45 个网站，resources.json 有 44 条。
- 安全评审称"GET 不改数据"，实际存在 GET 写库（4.1-8）。
- 培训手册称"上岗测验答对才激活"，实际只校验复述 ≥20 字（1519、1299）。
- 开场说明称"不要用仓库里的 deploy.py，它会重写绑定"——`deploy_prod.py` 同样整包重写绑定，区别只在于它能读到原 secret 文件。

---

## 5. PRODUCT.md 中的问题、不可行或缺失之处（附依据与替代方案，供负责人裁决）

严重程度：高 = 不改会导致数据丢失、安全事故或做不出来；中 = 会返工；低 = 措辞/一致性。

> （v4.3 修订注，2026-10-27：负责人已裁决部分条目——P1 采纳（D32）、**P3 驳回**（D35）、P4–P6 采纳（D38、D36、D37）、P7 采纳（D34）、P8 先实测（D40）、P13/P18 由 D30 解决、P14 采纳（D33）；其余待补充。对照表见 DECISIONS.md 第五节末。本节原文保留不改。）

### 5.1 高

| # | 位置 | 问题 | 依据 | 建议 |
|---|------|------|------|------|
| P1 | 13 第 2 条（Key 迁移） | 「在本机用 wrangler 运行一次性导出脚本」不可行：wrangler 不能直接读取 Durable Object 的 SQLite 数据；要导出密文只能在**旧 Worker 里部署一段导出代码**。这等于修改线上旧站，和「不碰 chat.pcmanai.com」「禁用 deploy.py」冲突；而两个旧部署脚本都会整包替换 secret 绑定（本文 4.3-1），一不小心会清空线上 Key | worker.js `ksAll` 218、`ksKey` 206；deploy.py 102-111；work/deploy_prod.py `put_script` | ①写明迁移需要用户批准一次「维护窗口」；②用保留已有绑定的方式部署导出代码（wrangler deploy 默认保留 secret，或 API 带 keep_bindings），先做 Worker 脚本和 DO 的备份；③导出接口只在 Worker 内解密，再用新系统的公钥重新加密后导出，导出后立即撤下；④需要 ACCESS_TOKEN（第 19 节第 3 条）和 Cloudflare 账号授权。建议新增决策条目 |
| P2 | 13 第 3 条（数据映射） | 表里的数字是**仓库预置条数**，不是线上实际数据：技能 148、网站 44（文中写 45）、点子 6 只是种子；成员、项目、消息、审计日志在线上 DO 里，条数未知。按这些数字做「对照报告」会误判迁移完整性 | 本文 2.2 | 迁移第一步改为「线上只读导出 + 计数」，对照报告以导出数为准；45 改为「44 条静态 + 线上 res_items 行数」 |
| P3 | 8.4、D8（字号规范） | 用户有严重的视力障碍，长时间看屏幕困难（2026-10-27 用户亲述；旧版把 19/21/23/25 号字、深浅色、减少动效、44px 点击区当硬约束）。PRODUCT 把桌面正文定为 14px、没有任何可访问性或读屏、语音优先的要求，等于悄悄删掉了旧版的硬需求 | 旧 page.html 设置区；附录 A 可访问性条目；本文第 1 节「可访问性」行 | 新增「可访问性」小节，作为高于 D8 的硬要求：字号缩放（至少 4 档或跟随系统）、完整读屏标签（不止圆环）、键盘与语音全流程可用、高对比度模式、每期验收清单可以靠语音或读屏完成；D8 改为「默认值」而不是上限 |
| P4 | 9.4、9.6（敏感项目） | 规格只说敏感项目「不调用工具」「不发网页顾问」，**没说外部智能体成员（Poke、Webhook、Telegram、小桥、Tailscale）也不能收**。旧代码正是在这里漏了，敏感内容会照常发给第三方 | worker.js `runTurn` 956-957、`dispatchAsync` 1019；本文 4.1-6 | 明确写出：敏感项目只发「官方 API + 本地 + 用户标记为可信的自托管智能体」；敏感判定在服务端做，项目建好后可以改；策略改动要用户确认，操作员不能改 |
| P5 | 9.3（操作员令牌） | 权限写成「不能做 X、Y、Z」的黑名单，和旧代码同一个毛病：新增接口默认对操作员开放（旧版操作员能通过 /api/settings 关掉敏感保护）。也没有过期时间和轮换 | worker.js `opDeny` 2647、`/api/settings` 1459 | 改为白名单（明确列出可调用的能力），默认拒绝；令牌加有效期（比如 30 天）和续期；培训激活改为真正的测验（旧版只检查复述满 20 字） |
| P6 | 9.5、9.8（资源管家「已核实」） | 「在官方页找到原句才标已核实」没有定义什么是官方页。旧实现里，被提交的网页本身就算官方页，所以任何页面都能自证（投毒风险，而且所有成员都把资源库当事实来源） | worker.js `verifyTiered` 1889、`ingestPage` 1923；本文 3.5 | 定义官方域名的来源：厂商域名表（来自 models.dev/资源档案）+ 用户确认；被提交的页面和官方页不同域才算交叉核实；没有官方域名的一律「未核实」 |

### 5.2 中

| # | 位置 | 问题 | 依据 | 建议 |
|---|------|------|------|------|
| P7 | 7.6、9.6 secret、11.3（保险箱） | 没写新系统的**主加密密钥放在哪里、怎么备份、谁能解**。旧系统的根本问题就是一个总令牌同时当登录凭据和加密密钥。7.6 只说「保险箱单独加密」 | 本文 2.3、4.1-1 | 新增：主密钥只存在主机的 .env 或系统密钥库里，和登录凭据分开；备份用独立的恢复密钥，由用户保管（安全表单交付），恢复演练要验证能用它解开；写清轮换流程 |
| P8 | 7.3（标准版 4 GB） | 标准版要跑 LobeHub server + PostgreSQL + LiteLLM + Core + Karakeep（它自己要 Meilisearch 和无头 Chrome）+ RSSHub + 网页代办，4 GB 很可能不够；电脑模式下 Windows + WSL2 + Docker Desktop 本身就要占 2–3 GB | Karakeep 官方 compose 包含 meilisearch 和 chrome 服务（第 20 节待实测） | 档位表标注「待第 20 节实测后定稿」；标准版考虑把 Karakeep 的爬取和 Chrome 交给执行设备，或者跟网页代办共用一个浏览器 |
| P9 | 6、11.1（LobeHub 深度改造） | 导航、头部、输入框、设置都要改，和「修改隔离在独立目录、便于合并上游」很难同时成立；LobeHub 迭代很快，合并成本会越来越高。v4.1 第 3 节还要求自研部分和 LobeHub 解耦 | v4 第 6 节、v4.1 第 3 节 | 优先用 LobeHub 的插件、主题、配置能力；必须改源码的地方集中在一个补丁层并记录清单；P1 开始前做一次「改动面评估」，作为 VERIFY 的一项 |
| P10 | 9.4（自动接班）、9.3（接班超时） | 没写超时由谁来计时。旧版是在「有人打开房间」时顺便检查，没人访问就永远不接班 | worker.js `leadCheck` 2419（由 GET 触发） | 写明由 Core 的定时任务或队列驱动，给出默认超时（旧版默认 180 秒） |
| P11 | 9.9、10.1 I1（日期边界） | 每日简报、额度重置、打扰预算、到期提醒都没写按哪个时区算。旧版混用伦敦时间和 UTC | worker.js 1758 | 全局默认 Asia/Shanghai，可在设置里改；免费额度重置按各来源自己的时区记在公共记忆 |
| P12 | 15.1（完成的定义）与 17.2.3（PR 规则） | 「先证明新用例在旧代码上会失败」对纯新项目（没有旧代码的模块）没法执行；CI 还不存在，main 也还没开保护 | — | 改为「新增行为必须有测试，修 bug 的 PR 必须先给出失败用例」；P0 第一项就是开 main 保护和 CI |
| P13 | 0.4（禁用 deploy.py） | 只点名禁用 deploy.py，但 work/deploy_prod.py 同样会整包重写绑定 | 本文 4.3-1、4.4 | 改为「禁用旧仓库里的所有部署脚本」 |
| P14 | 迁移后的旧凭据 | 迁移要用旧 ACCESS_TOKEN 解密，但没写迁移完成后要轮换所有 Key；旧 Key 曾经过 Hark 沙盒和多个中转站，cookie 里存的就是 ACCESS_TOKEN 原文 | 本文 2.3 | 迁移验收后提醒用户逐个轮换 Key（可以挂到 10.2 X5 轮换提醒），旧站只读期间撤销旧令牌 |

### 5.3 低

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P15 | 0.3、第 17 节 vs 17.2.3 | HANDOFF「由系统自动生成」和「执行者收工前手动更新」矛盾 | 已在 DECISIONS D28 提议：I3 上线前手动维护 |
| P16 | 0.1 vs 17.2 | 0.1 说接手 AI 是「首席开发者兼产品负责人」，17.2 里主程序员没有验收权 | 按 v4.2 为准（已在 PRODUCT 0.1 加修订注） |
| P17 | 9.3（对外 MCP） | 「旧版的 21 个工具」实际是 33 个 | 改成 33，迁移时逐个列出去留 |
| P18 | 文档头、任务说明 | 新仓库在 GitHub 上叫 uniwof/Aroomo-Developer，任务说明里写的是 aroomo-app | 由用户决定改名还是改文档（DECISIONS D29） |
| P19 | 仓库可见性 | uniwof/Aroomo 和 uniwof/Aroomo-Developer 都是**公开**仓库；旧仓库还暴露了 Cloudflare 账号 ID、Zone ID、第二账号用户名、用户邮箱和真实姓名 | 建议两个仓库都改成私有（Jules 和负责人可以通过授权访问）；如果负责人需要公开链接，至少从旧仓库删掉 work/deploy_prod.py、work/backup_live.sh |
| P20 | 9.1 心跳 | 「每日或每小时一次」没有和旧版 DO 额度事故挂钩的上限 | 心跳频率进设置，并受 9.6 的全局调用上限约束 |


---

## 6. 旧需求/决定清单（用于逐条对照 PRODUCT.md）

> 对照结果：大多数已被 PRODUCT.md 覆盖；未覆盖或被弱化的已汇总到第 5 节。

### 6.1 定位与原则
1. 产品是"空的公司框架"，用户自己接 Key/招人；不得预设 Hark 记忆里的资源（10-26）。
2. 优先级：用户需求 = AI 延伸的安全/创新功能 ＞ 最好的界面 ＞ 用户提到的界面细节。
3. 全部免费优先；付费必须用户确认；付费来源默认不用（`enrichAll` 460）。
4. 命名、Logo、域名、付费由用户拍板；产品名 Aroomo、Logo 不改；头像外额度圆环+细缝不可退让；在线彩色/离线黑白（替代红绿点）。
5. 可访问性硬约束：正文 ≥19px、点击区 ≥44px、深浅色、减少动效、颜色不是唯一信息载体；手机（iPhone）与桌面都好用。
6. 界面借鉴 Grok / Muse / ChatGPT(Codex) / Claude Code，不自主重新设计；说明文字改悬停/长按；顶部不放一排按钮；不靠滚动找内容。
7. 三层结构：前台（对话+收藏）、中台（成员通讯录）、后台（分工智能体+公共记忆，只通过通知/审批和每日简报出现）。
8. 网页 + Windows 客户端同一套界面；客户端承担常驻员工、登录态、本地模型、浏览器自动化（Tauri 2 方向，待定）。

### 6.2 对话与协作
9. 用户发言不耗模型额度；两种主持：用户点名 / 负责人托管；@ 成员、@ 能力分类；系统推荐该 @ 谁。
10. 默认像 ChatGPT 只和负责人对话，需要时 @ 成员或变群聊。
11. 协作过程透明：谁说了什么、采纳了什么、为什么；默认折叠成一行，可展开。
12. 快速建项目（全员在场）、手动勾选成员、负责人推荐；新建不强制选成员。
13. 暂停/继续、决策按钮（2-3 选项、幂等、只有用户能拍板）。
14. 失败自动换同能力成员，用户只见"已由 X 接替"。
15. 按任务选架构（单人/Workflow/并行多成员），审核是独立一步、审核者看不到自评。
16. 需求单一真源 + 版本号；开工/交付声明基于哪个版本；需求变更使进行中任务过期。
17. 守门人：事实附来源；每任务轮数上限与用量上限，超限停下问用户。
18. 成本可见（给负责人，用户只看简报汇总）；可追责（结论→成员→需求版本→来源）。
19. 发件箱：额度用完/断网时消息不丢，恢复后补发，**且补发后自动触发回应**。
20. 全局搜索覆盖项目、消息（扩展到收藏/点子/成员）。
21. 项目/会话、收藏、点子、成员都能删除、排序、置顶（重命名、归档建议）。
22. 同题并排对比归档（批准增强 ⑧）。
23. 项目完成自动沉淀为"方法"进资源库（批准增强）。
24. 项目共享记忆/当前版本摘要。

### 6.3 成员与来源
25. 以模型为单位招人，一个模型一张卡，多来源可轮换（一个用完换下一个）。
26. 英文原名；群内显示 `模型名（角色）`。
27. 能力分类（生图/文本/长文本/生视频/多模态/语音/代码/推理…），可多分类。
28. 招人宗旨：为每个模型找岗位；初始标签按社区评价（附来源），之后用户打分+互评+实测更新擅长/不擅长（≥2 次、均分阈值）。
29. 新成员试用期小考题，入职即有实测分（批准增强）。
30. 新增平台/Key 自动读 /v1/models：已有模型补来源，新模型进候选池，确认后入职；负责人候选列表实时同步。
31. 成员 vs 工具：调用方是成员，被调用方（显卡、号码、沙盒、代理、邮箱、浏览器、算力平台）是工具；Workers AI 类接口算模型来源。
32. 网页型成员：由有浏览器的执行者代发，需解决上下文传递、会话复用、超时改派、签到、"仅客户端型需用户同意操作电脑"。
33. 外部智能体接入方式：Poke、内网/Tailscale（CCCC、OpenCode、Claude Code）、Webhook（签名）、Telegram Bot、拉取小桥、网页代发、OpenAI 兼容端点。
34. 额度：能实查就实查，查不到按公开免费额度估算；用户只看圆环；每日来源心跳。
35. 角色卡用户侧只留：头像圆环、名字、能力标签、一句话擅长、参与项目、启用/停用/删除。

### 6.4 负责人体系
36. 任何智能体都可当负责人；主 + 副（备用）；A 内置大脑（合格模型）/ B 配对码，可混搭。
37. 负责人资格后端唯一判定：能文字对话、上下文 ≥32k、支持工具调用、能力已核实；生图/视频/语音/网页成员不能当；未知按不合格；不合格不静默替换，按接任规则并通知用户。
38. 配对码：不依赖任何模型、一次性、10 分钟、可无限重新生成（新码作废旧码）、任何在任负责人都能为接任者生成；新码配对成功前现任令牌不变。
39. 主负责人超时/不可用 → 副负责人自动接班并通知；副不合格时不升任；原主降为副（用户已选 A）。
40. 负责人培训：先读岗位说明书/培训手册，通过复述**或测验**才激活；交接备注随换人附给下一任。
41. 操作员令牌边界：不能看/导出 Key、不能删除、不能确认付费、不能改总令牌/吊销令牌、不能新建/修改自定义端点地址、不能新建引用密钥的成员；每次操作写审计；用户可一键吊销。
42. 场景："我的 Hark 额度没了，换哥哥的 Hark 接手，它能理解全部概念、项目和技能库"。
43. 用户在外部智能体 App 里发链接 → 负责人调 submit_resource 静默入库，只回"已收进 Aroomo 资源库"，不追问（常驻规则）。
44. 网页里不设"主负责人私聊"（已取消）。

### 6.5 收藏 / 资源库 / 点子
45. 收藏随手丢（链接、帖子、文件、文字），自动分类，不用用户分类；类型含工具、素材、参考、方法、学习网站、模型免费试用期限。
46. 所有成员可读（API + MCP）；开工前先查资源库，搜到的好东西回填。
47. 收藏可一键拿去和 AI 讨论；资源线索可直接变成新成员或新工具。
48. 资源管家唯一写入者：去重、按官方页核实、记到期、过期标记；丢链接直接入库（用户选 A），核实不了标"未核实"可一键删；整理用免费模型（Groq）。
49. 到期提醒、每周汇总；搜集羊毛只进"候选"（未经核实）。
50. 点子库：想法/计划/预期/标签/来源，三态"正在做/暂时收藏/已放弃"；项目可关联点子，关联后背景注入所有成员；项目结论回写点子；其他负责人那里聊到的点子也要汇总进来（点子收藏员）。

### 6.6 后台分工智能体
51. 资源管家、注册维护员、签到员、挖掘员、账号保管员、点子收藏员六类分工。
52. 后台不是常看页面：只在需要决定时（审批）和每日简报时出现；原"团队"页降级为带红点的通知/审批入口。
53. 合规边界：账号与登录态只在本机/保险箱，模型拿不到原文只知"已登录/已过期"；注册类动作先问用户；遵循用户隐私约定（临时邮箱/化名），不替换为真实邮箱。

### 6.7 后厨信息 → 公共记忆
54. 额度、速率、调用方式、冷启动、用量估算、免费额度周期、剩余、沙盒/显卡介绍、岗位说明书、探测结果、工具规则 → 公共记忆，所有成员共享，负责人据此派工；不在用户界面展示。
55. Cloudflare/平台用量是运维信息，只在影响可用时通知用户。

### 6.8 Key、账号与安全
56. 用户自定义任意 API（含任意 OpenAI 兼容地址）；Key 增删改；顶部常驻一行新增（获取网址/名称/Key/保存）；当场验证；只显示末 4 位；加密存储；不经过聊天。
57. **迁移时已填 Key 不丢失**（旧库用 ACCESS_TOKEN 派生密钥加密，需解密再迁）。
58. 多设备登录：一次性链接+二维码、10 分钟、单次、可无限生成；每设备独立长期令牌；设备列表（登录时间/最近使用）、单个/全部踢下线；写审计；不暴露总令牌；设备令牌校验不能大量读库。
59. 解耦派生关系：改登录凭据不应连带失效 Key 库、配对负责人、成员/代发员令牌、Telegram webhook。
60. 敏感项目：默认不敏感、命中敏感词自动标敏感（用户选 A）；敏感内容不发中转站/公益站/免 Key 公共接口/第三方网页/外部智能体、不调第三方工具；推送不带内容；全程审计。
61. 权限分级 + 审计日志；**清理测试数据时不得删审计日志**。
62. 工具调用：付费/不可逆动作需用户在网页确认；每工具/全站每日上限。
63. SSRF 防护、CSRF 同源校验、CSP、请求体上限、日志不记密钥（旧版已有，新版需等价或更强）。
64. 公司配置一键导出备份（批准增强）。
65. 完成推送（Telegram/Bark），默认关；语音发任务。

### 6.9 已删除/推翻（新规格不应再出现）
66. 朗读（TTS）功能（10-26 去掉）。
67. 主负责人私聊入口（10-23 取消）。
68. 头像旁红绿点（改为彩色/黑白头像）。
69. 给用户看的额度细节、速率、冷启动、周期（改为公共记忆）。
70. 中文给模型起名；按平台入选成员；把算力平台上的模型接口算作"算力"。

### 6.10 运维与交付流程（用户合作规矩，影响验收设计）
71. 分期交付，每期附用户测试清单（发哪句话/点哪里 → 看到什么算通过 → 不对回报什么），适合少看屏。
72. 定稿前让其他厂商模型做反对式评审，逐条裁决留档。
73. 借鉴前先查资源库，再查 GitHub（≥500 星、活跃、许可证明确），写明借鉴项目与许可证。
74. 部署：先备份 → TDD 红绿 → 本地全绿 → 复审 → 部署 → 线上一轮验收 → 不全绿回滚；保留已有 secret；平台免费额度用量超过 50% 停止部署与线上全测。
75. 线上测试数据需清理（测试甲/乙/丙、重复测试项目），审计日志保留。

---

## 附：本次产出与依据文件
- bundle 在本地克隆后只读查看，未做任何修改或推送。
- 主要依据：旧仓库 uniwof/Aroomo 下 `00-README-Aroomo-Requirements.md`、`01-Existing-Features-and-Rationale.md`、`00-先读-给接手Hark的开场说明.md`、`repo/worker.js`、`repo/caps.js`、`repo/p1.js`、`repo/toolgw.js`、`repo/page.html`、`repo/members.json`、`repo/resources.json`、`repo/deploy.py`、`repo/bridge.py`、`repo/localproxy.py`、`repo/wrangler.toml`、`repo/00-交接文档-HANDOFF.md`、`repo/docs/*`、`repo/docs-training/负责人培训手册.md`、`work/PROGRESS.md`、`work/deploy_prod.py`、`work/*.sh`、`ux-advice/建议清单.md`；bundle 独有的 `steward-test/待用户决定.md`、`steward-test/安全评审-groq-gpt-oss-120b-2026-10-23.md`。
- 未读全文（只看标题/抽查）：`ux-advice/review-*.md`、`work/review/*`（各批复审原文与日志）、`repo/ui-research/*`、`repo/用户测试清单.md`、`repo/naming.md`、`Aroomo-Requirements.docx`（与 00-README 同名，推测为同内容的 Word 版，未逐字比对）。
