/**
 * 工具网关的外部工具适配器接口（docs/adapters-boundary.md）。
 * 形状与 MCP tools/list + tools/call 对齐；适配器不直接依赖路由或存储，只依赖这里的小接口，方便合同测试。
 */
import type { AuditFn } from '../audit/types.js';

export type ToolRisk = 'read' | 'write' | 'spend' | 'danger';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（对象） */
  inputSchema: Record<string, unknown>;
  /** 该工具的默认风险；个别调用可由 riskOf 上调 */
  risk: ToolRisk;
}

export interface ToolCtx {
  userId: string;
  audit: AuditFn;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolAdapter {
  id: string;
  tools(): ToolSpec[];
  /** 按本次参数得出风险（网关据此决定要不要确认）；不实现则用 ToolSpec.risk */
  riskOf?(tool: string, args: Record<string, unknown>): ToolRisk;
  call(tool: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
}

export const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

const RANK: Record<ToolRisk, number> = { read: 0, write: 1, spend: 2, danger: 3 };
export const maxRisk = (a: ToolRisk, b: ToolRisk): ToolRisk => (RANK[a] >= RANK[b] ? a : b);
