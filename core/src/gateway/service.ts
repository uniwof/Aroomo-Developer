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
import { badRequest, notFound } from '../http/errors.js';
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
