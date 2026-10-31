# CONTEXT（开工只读这份 + 自己的工单，D239）

## 当前里程碑：M1（D244：一次只推一个，M1 经所有者验收确认前不派 M2）
只做 M1：#191 V2/V3 实测（VERIFY.md，用保险箱已有的测试模型 Key），结论记入 DECISIONS（LobeHub 或 Open WebUI）；修所有者 M1 验收问题。GitHub Milestone「M1」。
M2 工单（含 #173、#170、#171）、after-M2、deferred、POOL.md 里的项一律不领；后台/执行员/隔离三线暂停。没有 M1 工单就记一行收工。
验收：CI 全绿；两个账号各测一遍；所有者手机按 docs/acceptance/M1.md 测 10 分钟。

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
- A（鉴权、Key、确认、工具网关花钱/危险、隔离、凭据、接管）：自动测试含反例；加 needs-leader-review；#170+#171 都完成前按 #156 24 小时兜底，之后按 D235（CI 全绿 + 审查判「通过」，Groq 不算）可先合 dev。有带该标签的 PR 时不合 main、不打生产标签。
- B：关键路径单测，CI 绿 squash 合 dev。
- C（界面）：冒烟 + 手机试；14px、点击区 ≥44px、aria。

## 目录与边界
后台线 core/src 业务 | 隔离线 core/migrations RLS、core/src/db、seed | 控制台线 web/console、shell、deploy | 执行员线 executor、.github、scripts/ci | 流程工具冻结：只修不加 | installer 独立版冻结（只保留执行员安装/更新）| docs 文档。只改工单写明的文件。

## 规矩
一单一会话，PR 提交即结束。PR 说明三行（改了什么/怎么测/风险）+「工单 #N」。dev→main 只由所有者合。
细节按编号去 docs/DECISIONS.md 搜（如 grep D218），不要整份读。
