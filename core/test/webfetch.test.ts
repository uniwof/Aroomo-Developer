import { describe, expect, it, vi } from 'vitest';
import { WEB_MAX_BYTES, WEB_PER_DAY, WebFetchAdapter, htmlToText } from '../src/gateway/webfetch.js';
import type { ToolCtx } from '../src/adapters/types.js';

const audits: string[] = [];
const ctx: ToolCtx = { userId: 'u1', audit: async (a, _t, r, n) => void audits.push(`${a}|${r}|${n ?? ''}`) };
const pub = async () => ['93.184.216.34'];
const html = (s: string, type = 'text/html; charset=utf-8') => new Response(s, { status: 200, headers: { 'content-type': type } });
const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? '';

describe('读网页（内置工具，B/A 边界：SSRF）', () => {
  it('取正文：去脚本样式标签，保留标题', async () => {
    const f = vi.fn(async () => html('<html><title>你好</title><style>.a{}</style><script>alert(1)</script><body><p>第一段</p><p>第二&amp;段</p></body></html>'));
    const a = new WebFetchAdapter({ fetch: f as unknown as typeof fetch, resolveHost: pub });
    const r = await a.call('read_webpage', { url: 'https://example.com/x' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('# 你好');
    expect(text(r)).toContain('第一段');
    expect(text(r)).toContain('第二&段');
    expect(text(r)).not.toContain('alert');
    // 请求不带 cookie / 授权
    const init = (f.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.stringify(init.headers)).not.toMatch(/cookie|authorization/i);
    expect(init.redirect).toBe('manual');
  });

  it.each([
    'http://example.com/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://foo.localhost/',
    'https://user:pw@example.com/',
    'https://example.com:8443/',
    'ftp://example.com/',
    'not a url',
  ])('拒绝 %s，且不发请求', async (url) => {
    const f = vi.fn();
    const a = new WebFetchAdapter({ fetch: f as unknown as typeof fetch, resolveHost: pub });
    const r = await a.call('read_webpage', { url }, ctx);
    expect(r.isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('域名解析到内网（含 IPv4 映射的 IPv6）→ 拒绝', async () => {
    for (const ip of ['10.0.0.5', '169.254.169.254', '192.168.1.1', '172.16.0.1', '::ffff:127.0.0.1', 'fd00::1']) {
      const f = vi.fn();
      const a = new WebFetchAdapter({ fetch: f as unknown as typeof fetch, resolveHost: async () => ['93.184.216.34', ip] });
      expect((await a.call('read_webpage', { url: 'https://evil.example.com/' }, ctx)).isError).toBe(true);
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('重定向每一跳都重新校验：跳到内网被拒；最多 4 跳', async () => {
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    const resolve = async (h: string) => (h === 'internal.example.com' ? ['10.1.1.1'] : ['93.184.216.34']);
    const f1 = vi.fn(async () => redirect('https://internal.example.com/admin'));
    const a1 = new WebFetchAdapter({ fetch: f1 as unknown as typeof fetch, resolveHost: resolve });
    expect((await a1.call('read_webpage', { url: 'https://example.com/' }, ctx)).isError).toBe(true);
    expect(f1).toHaveBeenCalledTimes(1);
    const f2 = vi.fn(async () => redirect('https://example.com/loop'));
    const a2 = new WebFetchAdapter({ fetch: f2 as unknown as typeof fetch, resolveHost: pub });
    const r2 = await a2.call('read_webpage', { url: 'https://example.com/' }, ctx);
    expect(r2.isError).toBe(true);
    expect(text(r2)).toContain('重定向');
    expect(f2).toHaveBeenCalledTimes(5);
    // http 跳转也拒
    const f3 = vi.fn(async () => redirect('http://example.com/plain'));
    const a3 = new WebFetchAdapter({ fetch: f3 as unknown as typeof fetch, resolveHost: pub });
    expect((await a3.call('read_webpage', { url: 'https://example.com/' }, ctx)).isError).toBe(true);
    expect(f3).toHaveBeenCalledTimes(1);
  });

  it('超过 600KB 截断；非文字内容拒绝；非 2xx 报错', async () => {
    const big = 'a'.repeat(WEB_MAX_BYTES + 5000);
    const a = new WebFetchAdapter({ fetch: (async () => html(big, 'text/plain')) as unknown as typeof fetch, resolveHost: pub });
    const r = await a.call('read_webpage', { url: 'https://example.com/' }, ctx);
    expect(text(r)).toContain('600KB');
    expect(text(r).length).toBeLessThan(25_000);
    const b = new WebFetchAdapter({ fetch: (async () => html('x', 'application/pdf')) as unknown as typeof fetch, resolveHost: pub });
    expect((await b.call('read_webpage', { url: 'https://example.com/a.pdf' }, ctx)).isError).toBe(true);
    const c = new WebFetchAdapter({ fetch: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch, resolveHost: pub });
    expect((await c.call('read_webpage', { url: 'https://example.com/' }, ctx)).isError).toBe(true);
  });

  it('每用户每天 100 次，第二天重置；不同用户互不影响', async () => {
    let day = '2026-10-30T00:00:00Z';
    const a = new WebFetchAdapter({ fetch: (async () => html('ok')) as unknown as typeof fetch, resolveHost: pub, now: () => new Date(day) });
    for (let i = 0; i < WEB_PER_DAY; i++) expect((await a.call('read_webpage', { url: 'https://example.com/' }, ctx)).isError).toBeFalsy();
    expect((await a.call('read_webpage', { url: 'https://example.com/' }, ctx)).isError).toBe(true);
    expect((await a.call('read_webpage', { url: 'https://example.com/' }, { ...ctx, userId: 'u2' })).isError).toBeFalsy();
    day = '2026-10-31T00:00:00Z';
    expect((await a.call('read_webpage', { url: 'https://example.com/' }, ctx)).isError).toBeFalsy();
  });

  it('htmlToText 基本行为', () => {
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb');
  });
});
