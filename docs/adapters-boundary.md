# 工具网关外部工具适配器：文件边界（执行员线 ↔ 后台线）

- 执行员线只改 `core/src/adapters/**`（新目录）和 `core/test/adapters/**`。
- 后台线负责网关本体（core/src/router、mcpconfig 等）和 `core/src/adapters/index.ts` 的注册入口（一行引入）。
- 适配器接口：`{ id, tools(): ToolSpec[], call(tool, args, ctx): Promise<Result> }`；凭据只按 secret id 经 vault 现取，不打日志。
- 先做：外部 CLI 智能体适配器（调本机执行员任务队列），再按 Q3 账号到位情况加其他工具。

## 已实现（core/src/adapters/）
- `types.ts` 接口；`registry.ts` 注册表（`add` / `tools` / `find` / `riskOf`，后台线网关直接用）。
- `executor-agent.ts`：browser_task_create / status / cancel，经 ExecutorService 派任务；带凭据、登录、注册 = danger。
- `http-tool.ts`：通用 HTTP 工具（Bearer/Header/Query Key 经 vault.resolveForGateway 现取；只 https + 登记主机；拒内网/IP；不跟重定向；限大小/时间/每日次数）。
- 后台线接线：`new AdapterRegistry().add(new ExecutorAgentAdapter(executorService, (u, id) => vault.exists(u, id)))`，HTTP 工具按登记表逐条 `add(new HttpToolAdapter(def, { resolveSecret: (u, id) => vault.resolveForGateway(u, id) }))`；`spend`/`danger` 的确认由网关做。
