/**
 * 工具网关（HUB.md §3，M2）：把外部工具（本机执行员、登记的 HTTP 工具）统一成 list / call 两个动作。
 * 风险决定确认方式（D63/D199 红线 2）：read / write 直接执行；spend → 重要确认（付款）；danger → 重要确认（不可逆）。
 * 确认令牌绑定「工具名 + 参数」，换了参数就失效；重要确认只有所有者本人能完成。
 * Key 只经适配器在调用瞬间由保险箱解出，网关不碰明文。
 */
import type { AuditFn } from '../audit/types.js';
import { type HttpToolDef, HttpToolAdapter, checkDef, MemoryDayCounter } from '../adapters/http-tool.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { ExecutorAgentAdapter, type SecretExists, type TaskPort } from '../adapters/executor-agent.js';
import type { ToolResult, ToolRisk, ToolSpec } from '../adapters/types.js';
import { WebFetchAdapter } from './webfetch.js';
import { type ConfirmCtx, type ConfirmKind, ConfirmService } from '../confirm/confirm.js';
import { HttpError, badRequest, notFound } from '../http/errors.js';
import { type SettingsStore, scopedSettings } from '../settings/store.js';

const SETTINGS_KEY = 'gateway.http_tools';
export const MAX_HTTP_TOOLS = 30;

export interface PublicTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
}

export const confirmKindOf = (risk: ToolRisk): ConfirmKind | null => (risk === 'spend' ? 'payment' : risk === 'danger' ? 'irreversible' : null);

/** MCP 只放行的内置只读工具（M2）。放开要所有者批准。 */
const MCP_BUILTIN_READ: ReadonlySet<string> = new Set(['read_webpage']);
const MCP_DENIED_MSG = '工具不存在或当前客户端不可用';
/** MCP 路径的确认上下文：明确写出全部字段，什么都不能确认。 */
export const MCP_READ_ONLY_CTX: ConfirmCtx = Object.freeze({ actor: 'mcp', canConfirmImportant: false });

export class GatewayService {
  readonly #counter = new MemoryDayCounter();
  readonly #web: WebFetchAdapter;

  constructor(
    private readonly settings: SettingsStore,
    private readonly confirm: ConfirmService,
    private readonly now: () => Date,
    private readonly tasks: TaskPort,
    private readonly secretExists: SecretExists,
    private readonly resolveSecret: (userId: string, secretId: string) => Promise<string | null>,
    private readonly fetchImpl?: typeof fetch,
    private readonly resolveHost?: (h: string) => Promise<string[]>,
  ) {
    this.#web = new WebFetchAdapter({ now, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(resolveHost ? { resolveHost } : {}) });
  }

  async #defs(userId: string): Promise<HttpToolDef[]> {
    return (await scopedSettings(this.settings, userId).get<HttpToolDef[]>(SETTINGS_KEY)) ?? [];
  }

  async #registry(userId: string): Promise<AdapterRegistry> {
    const reg = new AdapterRegistry().add(this.#web).add(new ExecutorAgentAdapter(this.tasks, this.secretExists));
    for (const d of await this.#defs(userId)) {
      if (!d.enabled) continue;
      try {
        reg.add(
          new HttpToolAdapter(d, {
            resolveSecret: this.resolveSecret,
            now: this.now,
            counter: this.#counter,
            ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
            ...(this.resolveHost ? { resolveHost: this.resolveHost } : {}),
          }),
        );
      } catch {
        // 登记坏了的工具跳过，不拖垮整个网关
      }
    }
    return reg;
  }

  async list(userId: string): Promise<PublicTool[]> {
    return (await this.#registry(userId)).tools().map(({ name, description, inputSchema, risk }: ToolSpec) => ({ name, description, inputSchema, risk }));
  }

  async call(userId: string, tool: string, args: Record<string, unknown>, cctx: ConfirmCtx, audit: AuditFn): Promise<ToolResult> {
    const reg = await this.#registry(userId);
    const adapter = reg.find(tool);
    if (!adapter) throw notFound('没有这个工具');
    const risk = reg.riskOf(tool, args) ?? 'danger'; // 查不到风险按最危险处理
    const kind = confirmKindOf(risk);
    if (kind) {
      await this.confirm.require(
        {
          scope: `gateway.call:${userId}:${tool}`,
          kind,
          title: risk === 'spend' ? `用工具「${tool}」花钱` : `用工具「${tool}」做不可逆 / 涉及凭据的操作`,
          consequences: risk === 'spend' ? ['这次调用可能产生费用', '确认后立刻执行'] : ['这次操作做了就不能撤回', '确认后立刻执行'],
          confirmLabel: '确认执行',
          payload: { tool, args },
        },
        cctx,
        audit,
      );
    }
    await audit('gateway.call', { type: 'tool', id: tool }, 'ok', `risk=${risk}`);
    try {
      return await adapter.call(tool, args, { userId, audit });
    } catch (e) {
      if (e && typeof e === 'object' && 'statusCode' in e) throw e;
      await audit('gateway.call', { type: 'tool', id: tool }, 'failed', 'adapter error');
      return { content: [{ type: 'text', text: '工具调用失败了（详情已记入审计）。' }], isError: true };
    }
  }

  /** 列表和调用共用：必须是内置适配器提供的、白名单里的、静态与实际风险都是 read 的工具。 */
  #mcpCheck(reg: AdapterRegistry, name: string, args?: Record<string, unknown>): 'not_found' | 'not_read' | 'not_exposed' | null {
    const adapter = reg.find(name);
    if (!adapter) return 'not_found';
    const spec = reg.tools().find((t) => t.name === name);
    if (spec?.risk !== 'read' || (args && reg.riskOf(name, args) !== 'read')) return 'not_read';
    if (!MCP_BUILTIN_READ.has(name) || adapter !== this.#web) return 'not_exposed';
    return null;
  }

  /** /mcp 能看到、能调的工具：只有内置只读工具（M2 = read_webpage）。用户登记的 HTTP 工具（含重名）不经 MCP 开放。 */
  async listMcpReadable(userId: string): Promise<PublicTool[]> {
    const reg = await this.#registry(userId);
    return reg
      .tools()
      .filter((t) => this.#mcpCheck(reg, t.name) === null)
      .map(({ name, description, inputSchema, risk }: ToolSpec) => ({ name, description, inputSchema, risk }));
  }

  /** 给 /mcp 用：不在放行清单里一律返回同一条错误（审计记真实原因）；用「什么都不能确认」的上下文调用。 */
  async callRead(userId: string, tool: string, args: Record<string, unknown>, audit: AuditFn): Promise<ToolResult> {
    const reg = await this.#registry(userId);
    const reason = this.#mcpCheck(reg, tool, args);
    if (reason) {
      await audit('gateway.call', { type: 'tool', id: tool.slice(0, 64) }, 'denied', `mcp: ${reason}`);
      throw new HttpError(403, 'FORBIDDEN', MCP_DENIED_MSG);
    }
    return this.call(userId, tool, args, MCP_READ_ONLY_CTX, audit);
  }

  /** 给 /mcp 的任务工具用：只放行本机执行员的 browser_task_*，走同一套风险判断；带凭据 / 登录 / 注册 = danger，MCP 上下文不能确认 → 403 且不建任务。 */
  async callTask(userId: string, tool: string, args: Record<string, unknown>, audit: AuditFn): Promise<ToolResult> {
    const adapter = (await this.#registry(userId)).find(tool);
    if ((tool !== 'browser_task_create' && tool !== 'browser_task_cancel') || !(adapter instanceof ExecutorAgentAdapter)) {
      await audit('gateway.call', { type: 'tool', id: tool.slice(0, 64) }, 'denied', 'mcp: not_task_tool');
      throw new HttpError(403, 'FORBIDDEN', MCP_DENIED_MSG);
    }
    // 浏览任务的执行员保护尚未证明，MCP 这条路只放行签到
    if (tool === 'browser_task_create' && args.kind !== 'checkin') {
      await audit('gateway.call', { type: 'tool', id: tool }, 'denied', 'mcp: kind_not_allowed');
      throw new HttpError(403, 'FORBIDDEN', '这里只能派签到任务；登录 / 注册 / 浏览 / 带凭据的任务请在手机或控制台发起。');
    }
    // 签到只许带 kind 和 site：instruction / options / secrets 等一律拒（防提示注入借「签到」夹带指令）
    if (tool === 'browser_task_create' && Object.keys(args).some((k) => k !== 'kind' && k !== 'site')) {
      await audit('gateway.call', { type: 'tool', id: tool }, 'denied', 'mcp: field_not_allowed');
      throw new HttpError(403, 'FORBIDDEN', '这里派签到任务只能带 kind 和 site；其他字段请在手机或控制台发起。');
    }
    return this.call(userId, tool, args, MCP_READ_ONLY_CTX, audit);
  }

  // ---- HTTP 工具登记 ----
  async listHttpTools(userId: string): Promise<HttpToolDef[]> {
    return this.#defs(userId);
  }

  /** 登记 / 更新一个 HTTP 工具。它会把保险箱里的 Key 带去指定主机，所以是凭据类重要确认。 */
  async putHttpTool(userId: string, def: HttpToolDef, cctx: ConfirmCtx, audit: AuditFn): Promise<HttpToolDef> {
    const bad = checkDef(def);
    if (bad) throw badRequest(bad);
    if (def.auth.type !== 'none' && !(await this.secretExists(userId, def.auth.secretId))) throw badRequest('保险箱里没有这个 secretId');
    const cur = await this.#defs(userId);
    if (cur.length >= MAX_HTTP_TOOLS && !cur.some((d) => d.toolId === def.toolId)) throw badRequest(`最多登记 ${MAX_HTTP_TOOLS} 个 HTTP 工具`);
    await this.confirm.require(
      {
        scope: `gateway.http_tool:${userId}:${def.toolId}`,
        kind: 'credential',
        title: `登记工具「${def.name}」`,
        consequences: [`之后调用它会把保险箱里的 Key 发给 ${def.allowedHosts.join('、')}`, `风险级别：${def.risk}`],
        confirmLabel: '确认登记',
        payload: def,
      },
      cctx,
      audit,
    );
    const next = [...cur.filter((d) => d.toolId !== def.toolId), def];
    await scopedSettings(this.settings, userId).set(SETTINGS_KEY, next, this.now());
    await audit('gateway.http_tool.put', { type: 'tool', id: def.toolId }, 'ok');
    return def;
  }

  async deleteHttpTool(userId: string, toolId: string, audit: AuditFn): Promise<void> {
    const cur = await this.#defs(userId);
    if (!cur.some((d) => d.toolId === toolId)) throw notFound('没有这个工具');
    await scopedSettings(this.settings, userId).set(SETTINGS_KEY, cur.filter((d) => d.toolId !== toolId), this.now());
    await audit('gateway.http_tool.delete', { type: 'tool', id: toolId }, 'ok');
  }
}
