# 工具网关外部工具适配器：文件边界（执行员线 ↔ 后台线）

- 执行员线只改 `core/src/adapters/**`（新目录）和 `core/test/adapters/**`。
- 后台线负责网关本体（core/src/router、mcpconfig 等）和 `core/src/adapters/index.ts` 的注册入口（一行引入）。
- 适配器接口：`{ id, tools(): ToolSpec[], call(tool, args, ctx): Promise<Result> }`；凭据只按 secret id 经 vault 现取，不打日志。
- 先做：外部 CLI 智能体适配器（调本机执行员任务队列），再按 Q3 账号到位情况加其他工具。
