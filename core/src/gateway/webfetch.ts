/**
 * 内置工具「读网页」（资源清单工具 #1）：免 Key，只读公网 https 页面正文。
 * 安全：只 https；拒 IP 字面量 / localhost / 内网（含域名解析到内网）；重定向最多 4 跳且每跳重新校验；
 * 10 秒、600KB 上限；不带任何 cookie / 登录信息；每用户每天 100 次。
 * 已知限制：用全局 fetch，解析与连接之间理论上存在 DNS 重绑定窗口；加固阶段可换成固定 IP 连接的 undici dispatcher。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MemoryDayCounter, type DayCounter, isPrivateAddress } from '../adapters/http-tool.js';
import { type ToolAdapter, type ToolCtx, type ToolResult, type ToolSpec, textResult } from '../adapters/types.js';

export const WEB_MAX_BYTES = 600 * 1024;
export const WEB_TIMEOUT_MS = 10_000;
export const WEB_MAX_HOPS = 4;
export const WEB_PER_DAY = 100;
const OUT_CHARS = 20_000;

const SPEC: ToolSpec = {
  name: 'read_webpage',
  description: '读取一个公网 https 网页的正文文字（不登录、不带 cookie；最多 600KB，输出前约 2 万字）。',
  risk: 'read',
  inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'https:// 开头的网址' } } },
};

export interface WebFetchDeps {
  fetch?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  now?: () => Date;
  counter?: DayCounter;
}

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title ? `# ${title}\n\n${body}` : body;
}

export class WebFetchAdapter implements ToolAdapter {
  readonly id = 'builtin:web';
  readonly #fetch: typeof fetch;
  readonly #resolve: (h: string) => Promise<string[]>;
  readonly #now: () => Date;
  readonly #counter: DayCounter;

  constructor(deps: WebFetchDeps = {}) {
    this.#fetch = deps.fetch ?? fetch;
    this.#resolve = deps.resolveHost ?? (async (h) => (await lookup(h, { all: true })).map((r) => r.address));
    this.#now = deps.now ?? (() => new Date());
    this.#counter = deps.counter ?? new MemoryDayCounter();
  }

  tools(): ToolSpec[] {
    return [{ ...SPEC }];
  }

  /** 返回不通过的原因，通过返回 null */
  async #check(u: URL): Promise<string | null> {
    if (u.protocol !== 'https:') return '只允许 https 网址';
    if (u.username || u.password) return '网址里不能带账号密码';
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return '不允许访问内网地址';
    if (isIP(host)) return '不允许直接用 IP 地址';
    if (u.port && u.port !== '443') return '只允许 443 端口';
    let ips: string[];
    try {
      ips = await this.#resolve(host);
    } catch {
      return '域名解析失败';
    }
    if (!ips.length || ips.some(isPrivateAddress)) return '不允许访问内网地址';
    return null;
  }

  async call(tool: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
    if (tool !== SPEC.name) return textResult('没有这个工具', true);
    const raw = typeof args.url === 'string' ? args.url.trim() : '';
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return textResult('网址不对', true);
    }
    const day = this.#now().toISOString().slice(0, 10);
    if ((await this.#counter.hit(ctx.userId, day)) > WEB_PER_DAY) return textResult(`今天读网页已超过 ${WEB_PER_DAY} 次上限`, true);

    for (let hop = 0; hop <= WEB_MAX_HOPS; hop++) {
      const bad = await this.#check(u);
      if (bad) {
        await ctx.audit('gateway.web', { type: 'host', id: u.hostname }, 'denied', bad);
        return textResult(bad, true);
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), WEB_TIMEOUT_MS);
      try {
        const res = await this.#fetch(u, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': 'Aroomo-WebReader/1', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' } });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) return textResult('网页重定向没有目标地址', true);
          try {
            u = new URL(loc, u);
          } catch {
            return textResult('网页重定向地址不对', true);
          }
          continue;
        }
        if (!res.ok) return textResult(`网页返回 ${res.status}`, true);
        const type = res.headers.get('content-type') ?? '';
        if (type && !/^(text\/|application\/(xhtml\+xml|xml|json))/i.test(type)) return textResult(`不是文字网页（${type.split(';')[0]}）`, true);
        const buf = await readCapped(res, WEB_MAX_BYTES);
        const text = /html|xml/i.test(type) || !type ? htmlToText(buf.text) : buf.text.trim();
        await ctx.audit('gateway.web', { type: 'host', id: u.hostname }, 'ok', `${buf.bytes}B`);
        const out = text.length > OUT_CHARS ? `${text.slice(0, OUT_CHARS)}\n…（后面还有，已截断）` : text;
        return textResult(`${u.toString()}\n\n${out || '（网页没有可读文字）'}${buf.truncated ? '\n（页面超过 600KB，只读了前面一部分）' : ''}`);
      } catch (e) {
        const aborted = (e as Error).name === 'AbortError';
        return textResult(aborted ? '网页 10 秒内没有响应' : '网页读取失败', true);
      } finally {
        clearTimeout(timer);
      }
    }
    return textResult(`重定向超过 ${WEB_MAX_HOPS} 次`, true);
  }
}

async function readCapped(res: Response, max: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      chunks.push(value.subarray(0, value.byteLength - (bytes - max)));
      bytes = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}
