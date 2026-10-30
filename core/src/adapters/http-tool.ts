/**
 * 通用 HTTP 外部工具适配器（docs/architecture/HUB.md §3）：
 * 网关代用户调用第三方 API；Key 只在调用瞬间由保险箱解出，不返回、不进日志；
 * 只允许登记的 https 主机，拒绝 IP 字面量 / 内网 / localhost（SSRF），不跟随重定向，限响应大小与时间。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type ToolAdapter, type ToolCtx, type ToolResult, type ToolRisk, type ToolSpec, textResult } from './types.js';

export interface HttpToolDef {
  toolId: string;
  name: string;
  description?: string;
  /** 例如 https://api.example.com/v1 */
  baseUrl: string;
  auth: { type: 'none' } | { type: 'bearer' | 'header' | 'query'; secretId: string; headerName?: string };
  allowedHosts: string[];
  risk: ToolRisk;
  perDayLimit: number;
  enabled: boolean;
}

export interface HttpToolDeps {
  resolveSecret: (userId: string, secretId: string) => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 解析主机名到 IP，用于拒绝解析到内网的域名；测试可注入 */
  resolveHost?: (host: string) => Promise<string[]>;
  /** 每用户每工具每天的调用计数；默认进程内 */
  counter?: DayCounter;
}

export interface DayCounter {
  /** 记一次并返回今天的累计次数 */
  hit(key: string, day: string): Promise<number>;
}

export class MemoryDayCounter implements DayCounter {
  #m = new Map<string, number>();
  async hit(key: string, day: string): Promise<number> {
    const k = `${day}|${key}`;
    const n = (this.#m.get(k) ?? 0) + 1;
    this.#m.set(k, n);
    return n;
  }
}

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const TIMEOUT_MS = 20_000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** 内网 / 保留地址（IPv4、IPv6）判断 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = p;
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true; // 不是 IP 就按不安全处理
}

export function checkDef(d: HttpToolDef): string | null {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(d.toolId)) return 'toolId 只能用小写字母、数字、下划线';
  let u: URL;
  try {
    u = new URL(d.baseUrl);
  } catch {
    return 'baseUrl 不是有效网址';
  }
  if (u.protocol !== 'https:') return '只允许 https';
  if (u.username || u.password) return 'baseUrl 里不能带账号密码';
  if (!d.allowedHosts.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase())) return 'baseUrl 的主机不在 allowedHosts 里';
  for (const h of d.allowedHosts) if (isIP(h) || h === 'localhost' || h.includes('*')) return 'allowedHosts 只能写具体域名';
  if (d.auth.type !== 'none' && !d.auth.secretId) return '缺少 secretId';
  if ((d.auth.type === 'header' || (d.auth.type === 'query' && d.auth.headerName)) && !/^[A-Za-z0-9-]{1,64}$/.test(d.auth.headerName ?? '')) return 'header 名不合法';
  return null;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export class HttpToolAdapter implements ToolAdapter {
  readonly id: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #resolveHost: (h: string) => Promise<string[]>;
  readonly #counter: DayCounter;

  constructor(
    private readonly def: HttpToolDef,
    private readonly deps: HttpToolDeps,
  ) {
    const bad = checkDef(def);
    if (bad) throw new Error(`工具登记不合法：${bad}`);
    this.id = `http:${def.toolId}`;
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? (() => new Date());
    this.#resolveHost = deps.resolveHost ?? (async (h) => (await lookup(h, { all: true })).map((r) => r.address));
    this.#counter = deps.counter ?? new MemoryDayCounter();
  }

  tools(): ToolSpec[] {
    if (!this.def.enabled) return [];
    return [
      {
        name: this.def.toolId,
        description: this.def.description ?? `${this.def.name}（经网关调用，Key 不会暴露）`,
        risk: this.def.risk,
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: {
            method: { type: 'string', enum: [...METHODS], default: 'GET' },
            path: { type: 'string', description: '相对 baseUrl 的路径，如 /search' },
            query: { type: 'object', additionalProperties: { type: 'string' } },
            body: { description: 'JSON 请求体' },
          },
        },
      },
    ];
  }

  async call(tool: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
    if (tool !== this.def.toolId || !this.def.enabled) return textResult('这个工具没有启用', true);
    const method = String(args.method ?? 'GET').toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) return textResult('不支持的方法', true);
    const path = typeof args.path === 'string' ? args.path : '';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..'))
      return textResult('path 必须以 / 开头，且不能含 .. 或 //', true);

    const url = new URL(this.def.baseUrl.replace(/\/+$/, '') + path);
    if (url.hostname.toLowerCase() !== new URL(this.def.baseUrl).hostname.toLowerCase() || url.protocol !== 'https:')
      return textResult('目标主机不在允许范围', true);
    const q = args.query;
    if (q && typeof q === 'object') for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));

    // 解析到内网的域名一律拒绝（DNS 重绑定窗口仍存在，见 PR 说明）
    let addrs: string[];
    try {
      addrs = await this.#resolveHost(url.hostname);
    } catch {
      return textResult('域名解析失败', true);
    }
    if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
      await ctx.audit('tool.call', { type: 'tool', id: this.def.toolId }, 'denied', 'ssrf');
      return textResult('目标地址不允许访问', true);
    }

    const n = await this.#counter.hit(`${ctx.userId}|${this.def.toolId}`, dayOf(this.#now()));
    if (n > this.def.perDayLimit) {
      await ctx.audit('tool.call', { type: 'tool', id: this.def.toolId }, 'denied', 'per-day-limit');
      return textResult('今天的调用次数已用完', true);
    }

    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.8' };
    let secret: string | null = null;
    if (this.def.auth.type !== 'none') {
      secret = await this.deps.resolveSecret(ctx.userId, this.def.auth.secretId);
      if (!secret) return textResult('这个工具的 Key 取不出来，请在保险箱里重新填写', true);
      if (this.def.auth.type === 'bearer') headers.authorization = `Bearer ${secret}`;
      else if (this.def.auth.type === 'header') headers[this.def.auth.headerName ?? 'x-api-key'] = secret;
      else url.searchParams.set(this.def.auth.headerName ?? 'key', secret);
    }
    let body: string | undefined;
    if (args.body !== undefined && method !== 'GET') {
      body = JSON.stringify(args.body);
      headers['content-type'] = 'application/json';
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await this.#fetch(url, { method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: ac.signal });
      if (res.status >= 300 && res.status < 400) {
        await ctx.audit('tool.call', { type: 'tool', id: this.def.toolId }, 'failed', `redirect ${res.status}`);
        return textResult('对方要求跳转，网关不跟随重定向', true);
      }
      let text = await readLimited(res, MAX_RESPONSE_BYTES);
      if (secret && secret.length >= 6) text = text.split(secret).join('[已隐藏]');
      await ctx.audit('tool.call', { type: 'tool', id: this.def.toolId }, res.ok ? 'ok' : 'failed', `${method} ${res.status}`);
      return textResult(`HTTP ${res.status}\n${text}`, !res.ok);
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? '请求超时' : '请求失败';
      await ctx.audit('tool.call', { type: 'tool', id: this.def.toolId }, 'failed', msg);
      return textResult(msg, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      chunks.push(value.subarray(0, value.length - (total - max)));
      await reader.cancel();
      return Buffer.concat(chunks).toString('utf8') + '\n…（已截断）';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
