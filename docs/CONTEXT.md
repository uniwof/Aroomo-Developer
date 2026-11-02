# CONTEXT（开工只读这份 + 自己的工单，D239）

## 当前里程碑：M2（目标 11-04；M3 11-07、M4 11-10；D248）
M2 = #120 工具网关 + #115 /mcp + 首个外部工具端到端（新工单）+ MCP 配置可复制。GitHub Milestone「M2」。#117 在 M3，#172 在 M4，#188 在 POOL。
A 类按真实依赖并行合（#120、#115 互不依赖），后合的负责变基；只变基且 range-diff 无逻辑变化保留批准（评论贴 range-diff），有逻辑变化重新审。
有工单连续做，没工单记一行即结束；needs:main 归主会话。D249=A：加固与里程碑并行——隔离线 RLS 批次后接 #178，执行员线 #189 简化版→#177（d213-1），控制台线 #171。D250：先做个人+家人自用版，收费/计费暂停；加固只做家人多账号必需的；表带 user_id、用量/审计照记、Key 按用户隔离。省额度：测试只写验收标准与负责人必改项要求的；必改项一轮改完再送审；不为 POOL/后续里程碑写代码。
验收：CI 全绿；Hark 先在 staging 用两个账号跑完验收清单，所有者再测 10 分钟。

## 文档（D244）
以五件套为准：PROJECT.md、CONTEXT.md、DECISIONS.md、POOL.md（新想法先进池子）、PROGRESS.md。PRODUCT/HANDOFF/TICKETS 降为只查不读。

## D199 红线（永远）
1 密钥、cookie、验证码不进仓库/日志/模型上下文
2 花钱、不可逆、凭据操作走重要确认
3 Key 只在 LiteLLM 或保险箱，界面不见明文
4 R2 加密备份每天跑
5 新依赖可商用、零授权费（许可证闸门）
6 不改 LobeHub，只原样用

## 风险分级
- A+（只开 PR、加 needs-leader-review、等负责人亲审）：主密钥与备份加密、保险箱加解密、core/src/confirm、core/src/auth/plugin.ts 与 tokens、forUser/RLS 底层、D207 长期授权、路径闸门本身。清单：.github/a-plus-paths.txt + scripts/ci/path-guard.py。
- A（鉴权、Key、确认、工具网关花钱/危险、隔离、凭据、接管）：自动测试含反例；加 needs-leader-review；#170+#171 都完成前按 #156 24 小时兜底，之后按 D235（CI 全绿 + 审查判「通过」，Groq 不算）可先合 dev。有 needs-leader-review 但没有 leader-approved 的 PR 时不合 main、不打生产标签（「已审」以 leader-approved 为准，needs-leader-review 留给路径闸门）。
- B：关键路径单测，CI 绿 squash 合 dev。
- C（界面）：冒烟 + 手机试；14px、点击区 ≥44px、aria。

## 目录与边界
后台线 core/src 业务 | 隔离线 core/migrations RLS、core/src/db、seed | 控制台线 web/console、shell、deploy | 执行员线 executor、.github、scripts/ci | 流程工具冻结：只修不加 | installer 独立版冻结（只保留执行员安装/更新）| docs 文档。只改工单写明的文件。

## 规矩
一单一会话，PR 提交即结束。PR 说明三行（改了什么/怎么测/风险）+「工单 #N」。dev→main 只由所有者合。
细节按编号去 docs/DECISIONS.md 搜（如 grep D218），不要整份读。
