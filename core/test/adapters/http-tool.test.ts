import { describe, expect, it, vi } from 'vitest';
import { HttpToolAdapter, type HttpToolDef, MAX_RESPONSE_BYTES, checkDef, isPrivateAddress } from '../../src/adapters/http-tool.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import type { ToolCtx } from '../../src/adapters/types.js';

const SECRET = ['fake', 'tok', String(Date.now()), 'zzzz'].join('_');
const def: HttpToolDef = {
  toolId: 'search',
  name: '搜索',
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'bearer', secretId: 's1' },
  allowedHosts: ['api.example.com'],
  risk: 'read',
  perDayLimit: 2,
  enabled: true,
};
const audits: string[] = [];
const ctx: ToolCtx = {
  userId: 'u1',
  audit: async (action, _t, result, note) => {
    audits.push(`${action}|${result}|${note ?? ''}`);
  },
};
const publicIp = async () => ['93.184.216.34'];

function make(over: Partial<HttpToolDef> = {}, fetchImpl?: typeof fetch, resolveHost = publicIp) {
  const f = fetchImpl ?? (vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch);
  const a = new HttpToolAdapter({ ...def, ...over }, {
    resolveSecret: async (u, id) => (u === 'u1' && id === 's1' ? SECRET : null),
    fetch: f,
    resolveHost,
    now: () => new Date('2026-10-30T00:00:00Z'),
  });
  return { a, f };
}

describe('HTTP 外部工具适配器', () => {
  it('Bearer 注入 Key，响应里回显的 Key 被隐藏，审计里没有 Key', async () => {
    audits.length = 0;
    const seen: Record<string, string>[] = [];
    const f = (async (_u: URL, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(`你的 key 是 ${SECRET}`, { status: 200 });
    }) as unknown as typeof fetch;
    const { a } = make({}, f);
    const r = await a.call('search', { path: '/q', query: { a: '1' } }, ctx);
    expect(seen[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(r.content[0]?.text).not.toContain(SECRET);
    expect(r.content[0]?.text).toContain('[已隐藏]');
    expect(audits.join('\n')).not.toContain(SECRET);
  });

  it('别的用户取不到 Key 时不发请求', async () => {
    const { a, f } = make();
    const r = await a.call('search', { path: '/q' }, { ...ctx, userId: 'u2' });
    expect(r.isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('SSRF：解析到内网、IP 字面量、路径穿越、跨主机都被拒', async () => {
    const { a, f } = make({}, undefined, async () => ['10.0.0.5']);
    expect((await a.call('search', { path: '/q' }, ctx)).isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
    const ok = make();
    for (const p of ['/../admin', '//evil.com/x', 'http://evil.com', '/a\\b']) {
      expect((await ok.a.call('search', { path: p }, ctx)).isError).toBe(true);
    }
    expect(ok.f).not.toHaveBeenCalled();
    expect(checkDef({ ...def, baseUrl: 'https://169.254.169.254/', allowedHosts: ['169.254.169.254'] })).toMatch(/域名/);
    expect(checkDef({ ...def, baseUrl: 'http://api.example.com' })).toMatch(/https/);
    expect(checkDef({ ...def, baseUrl: 'https://other.com' })).toMatch(/allowedHosts/);
    expect(() => new HttpToolAdapter({ ...def, baseUrl: 'https://user:pw@api.example.com' }, { resolveSecret: async () => null })).toThrow();
  });

  it('私网地址判断', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('不跟随重定向；响应超大被截断；每日限额', async () => {
    const redir = make({}, (async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254' } })) as unknown as typeof fetch);
    expect((await redir.a.call('search', { path: '/q' }, ctx)).content[0]?.text).toMatch(/跳转/);
    const big = make({}, (async () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 5000))) as unknown as typeof fetch);
    const r = await big.a.call('search', { path: '/q' }, ctx);
    expect(r.content[0]?.text.length).toBeLessThan(MAX_RESPONSE_BYTES + 100);
    expect(r.content[0]?.text).toContain('已截断');
    const lim = make();
    await lim.a.call('search', { path: '/1' }, ctx);
    await lim.a.call('search', { path: '/2' }, ctx);
    const third = await lim.a.call('search', { path: '/3' }, ctx);
    expect(third.isError).toBe(true);
    expect(lim.f).toHaveBeenCalledTimes(2);
  });

  it('停用的工具不出现在清单里；注册表拒绝重名并给出风险', () => {
    expect(make({ enabled: false }).a.tools()).toEqual([]);
    const reg = new AdapterRegistry().add(make().a);
    expect(reg.tools().map((t) => t.name)).toEqual(['search']);
    expect(reg.riskOf('search', {})).toBe('read');
    expect(reg.riskOf('nope', {})).toBeNull();
    expect(() => reg.add(make().a)).toThrow();
  });
});
