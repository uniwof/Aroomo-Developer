# CONTEXT（开工只读这份+工单，D239）

## 当前（11-07 起，方案 v2.2）
- 阶段 1.5：所有者专用 v0.2.0 = dev→main 整条合并后打标签。#288、#290（#294）、#297 必须同一发布，同次在生产 .env 设 CORE_OWNER_ACCOUNT_ID；阶段 2/3 开关与定时在生产关。
- 阶段 3 已在 dev：会话存库+一键导入、推送、压缩、应用角色 aroomo_core_app（staging 已开 CORE_DB_REQUIRE_APP_ROLE；生产在 v0.2.0 跑稳后另一天，第二个用户进生产前必做）；staging 定时 11-06 18:52 起测 3 天。
- 阶段 4 已在 dev：头像与文案换掉仿 sumus（D258）、欢迎引导 F-018、断网提示 F-020、32px 无横滚进 CI F-144、Trivy 周扫、/work 切片 1（WORK 默认关）。
- 等所有者：v0.2.0 与 dev→main、#331 规则集临时改、staging 密码、F-043 导出、WORK 开关、头像进生产。等负责人（额度 11-08 恢复）：#335 #339 #334。
有工单连续做，没工单记一行就结束；needs:main 归主会话。测试只写验收与必改项要求的；必改项一轮改完；收费暂停（D250）；不为 POOL/以后写代码。
D251 MCP：外部客户端不能确认 important、不能调白名单外工具；白名单只有内置只读 read_webpage，list_tools/call_tool 同一清单；扩白名单或加 scope 要所有者批准；旧授权不自动得新工具。

## 审查（D252）
- A+（负责人完整审，最多两轮，二轮只核对上轮必改）：鉴权/会话/令牌、RLS 与隔离（userId、迁移）、保险箱/Key、钱、删数据、生产部署、新 scope/MCP 工具/白名单、确认卡与审计逻辑。碰 auth、迁移、RLS、vault、confirm、audit、部署脚本自动升 A+。
- A：只审一次，首审列全必改；改完 PR 贴「必改逐条对照 + range-diff」，CI 与 CodeQL 绿即合；之后发现的开后续工单（可利用越权/花钱漏洞例外）。
- B/C：不经负责人，CI 绿 squash 合 dev。反向测试只覆盖验收标准 + 越权（跨账号、缺权限、白名单外）。
- 复审只送增量 diff + range-diff + 上轮必改逐条回复；有待审立刻送。变基 range-diff 无逻辑变化保留批准（D248）。
- 有未获 leader-approved 的 A/A+ PR 时不合 main、不打生产标签；dev→main 只由所有者合。

## D199 红线（永远）
1 密钥、cookie、验证码不进仓库/日志/模型
2 花钱、不可逆、凭据操作走重要确认
3 Key 只在 LiteLLM/保险箱，界面不见明文
4 R2 加密备份每天跑
5 新依赖可商用、零授权费
6 不改 LobeHub，只原样用

## 边界
后台 core/src 业务 | 隔离 migrations RLS、core/src/db、seed | 控制台 web/console、shell、deploy | 执行员 executor、.github、scripts/ci | 流程工具只修不加 | 独立版冻结。只改工单写明的文件。C 界面：默认字号跟 sumus（11–16px）、设置滑块 12–32、点击区 ≥44px、aria。
一单一会话。PR 说明三行（改了什么/怎么测/风险）+「工单 #N」。细节 grep docs/DECISIONS.md 编号。
