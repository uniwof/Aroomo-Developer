# CONTEXT（开工只读这份 + 自己的工单，D227）

## 当前里程碑：M2（D228，串行 M2→M3→M4）
内容：工具网关 + 1–2 个外部工具；Core /mcp 接入 LobeHub；资源库最小版 + 规矩注入。
顺序：#111 → #120 → #115 → #117（见 #173）。另有 #171 生产只部署 main 标签版（先于 B 类）。
M2 期间空闲只做：①所有者验收报的问题 ②本里程碑 C 类打磨。下个里程碑的工单不派。
验收：CI 全绿；两个账号（所有者 + 小号）各测一遍，小号看不到/改不了所有者数据；所有者手机按 docs/acceptance/M2.md 测 10 分钟。

## D199 红线（永远）
1 密钥、cookie、验证码不进仓库/日志/模型上下文
2 花钱、不可逆、凭据操作走重要确认
3 Key 只在 LiteLLM 或保险箱，界面不见明文
4 R2 加密备份每天跑
5 新依赖可商用、零授权费（许可证闸门）
6 不改 LobeHub，只原样用

## 风险分级
- A+（只开 PR、加 needs-leader-review、等负责人亲审）：主密钥与备份加密、保险箱加解密、core/src/confirm、core/src/auth/plugin.ts 与 tokens、forUser/RLS 底层、D207 长期授权、路径闸门本身。清单：.github/a-plus-paths.txt + scripts/ci/path-guard.py。
- A（鉴权、Key、确认、工具网关花钱/危险、隔离、凭据、接管）：自动测试含反例；加 needs-leader-review；#171 上线前按 #156 24 小时兜底，上线后按 D223（CI 全绿 + 审查判「通过」，Groq 不算）可先合 dev。有带该标签的 PR 时不合 main、不打生产标签。
- B：关键路径单测，CI 绿 squash 合 dev。
- C（界面）：冒烟 + 手机试；14px、点击区 ≥44px、aria。

## 目录与边界
core/src 业务 | core/migrations 迁移 | web/console 控制台 | shell 薄层 | deploy、scripts 部署 | executor 本机执行员 | .github、scripts/ci 流程（冻结：只修不加）| docs 文档。只改工单写明的文件。

## 规矩
一单一会话，PR 提交即结束。PR 说明三行（改了什么/怎么测/风险）+「工单 #N」。dev→main 只由所有者合。
细节按编号去 docs/DECISIONS.md 搜（如 grep D218），不要整份读。
