import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createShellServer } from '../src/server.js';
import type { SessionChecker } from '../src/session.js';

const HTML = '<!doctype html><html><head><title>LobeHub · 你的 AI 助手</title><link rel="icon" href="/favicon.ico?v=1"><link rel="manifest" href="/manifest.json"></head><body><div id="root"></div></body></html>';

let lobe: Server;
let core: Server;
let shell: Server;
let shellNoToken: Server;
let base = '';
let baseNoToken = '';
const coreSeen: Array<{ url: string; auth?: string; cookie?: string; access?: string }> = [];
const lobeSignOut: Array<{ cookie?: string; origin?: string }> = [];
const lobeSeen: Array<{ url: string; cookie?: string; acceptEncoding?: string; host?: string }> = [];

const sockets = new Set<net.Socket>();
const listen = (s: Server) => {
  s.on('connection', (c: net.Socket) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  return new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
};

const session: SessionChecker = { check: async (c) => Boolean(c && c.includes('session=good')) };

beforeAll(async () => {
  lobe = http.createServer((req, res) => {
    lobeSeen.push({ url: req.url ?? '', cookie: req.headers.cookie, acceptEncoding: req.headers['accept-encoding'] as string, host: req.headers.host });
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(HTML));
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: LobeHub 1\n\n');
      setTimeout(() => res.end('data: 2\n\n'), 20);
      return;
    }
    if (req.url === '/api/auth/sign-out' && req.method === 'POST') {
      lobeSignOut.push({ cookie: req.headers.cookie, origin: req.headers.origin as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'better-auth.session_token=; Max-Age=0; Path=/' });
      return res.end('{"success":true}');
    }
    if (req.url === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"name":"LobeHub"}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'a=1; Path=/' });
    res.end(HTML);
  });
  lobe.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
  });
  core = http.createServer((req, res) => {
    coreSeen.push({
      url: req.url ?? '',
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
      access: req.headers['cf-access-jwt-assertion'] as string | undefined,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
    res.end('{"ok":true}');
  });
  const lobeUrl = await listen(lobe);
  const coreUrl = await listen(core);
  const cfg = loadConfig({ LOBE_UPSTREAM: lobeUrl, CORE_UPSTREAM: coreUrl, CORE_OWNER_TOKEN: 'placeholder-owner-token-0123456789abcdef' });
  shell = createShellServer(cfg, { session });
  base = await listen(shell);
  shellNoToken = createShellServer(loadConfig({ LOBE_UPSTREAM: lobeUrl, CORE_UPSTREAM: coreUrl }), { session });
  baseNoToken = await listen(shellNoToken);
});

afterAll(async () => {
  for (const c of sockets) c.destroy();
  for (const s of [shell, shellNoToken, lobe, core]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

const html = { accept: 'text/html,application/xhtml+xml' };

describe('LobeHub 页面', () => {
  it('D190：HTML 原样转发——不注入、不换品牌和图标；只补默认简体中文 Cookie', async () => {
    const res = await fetch(`${base}/`, { headers: { ...html, 'accept-encoding': 'gzip, br' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(HTML);
    expect(body).not.toContain('/aroomo/static/');
    // 压缩协商原样交给上游
    expect(lobeSeen.at(-1)?.acceptEncoding).toBe('gzip, br');
    // 新访客：带上 LOBE_LOCALE=zh-CN，并写回 cookie；上游自己的 set-cookie 保留
    expect(lobeSeen.at(-1)?.cookie).toContain('LOBE_LOCALE=zh-CN');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('LOBE_LOCALE=zh-CN'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('a=1'))).toBe(true);
    // Host 原样传给 LobeHub（Better Auth 校验来源要用）
    expect(lobeSeen.at(-1)?.host).toBe(new URL(base).host);
  });

  it('已有语言 cookie 时不覆盖', async () => {
    const res = await fetch(`${base}/agent/x`, { headers: { ...html, cookie: 'LOBE_LOCALE=en-US' } });
    await res.text();
    expect(lobeSeen.at(-1)?.cookie).toBe('LOBE_LOCALE=en-US');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('LOBE_LOCALE'))).toBe(false);
  });

  it('上游压缩的 HTML 原样透传（不解压不改写）', async () => {
    const r = await fetch(`${base}/gz`, { headers: html });
    expect(r.headers.get('content-encoding')).toBe('gzip');
    expect(await r.text()).toBe(HTML);
  });

  it('非 HTML（接口、流式输出）原样转发', async () => {
    expect(await (await fetch(`${base}/api/data`)).text()).toBe('{"name":"LobeHub"}');
    const sse = await (await fetch(`${base}/sse`)).text();
    expect(sse).toBe('data: LobeHub 1\n\ndata: 2\n\n');
  });

  it('D190：不按路径隐藏或拦截 LobeHub 的页面与接口（功能取舍只用官方 FEATURE_FLAGS）', async () => {
    for (const p of ['/community', '/discover/assistant', '/settings/provider', '/favicon.ico', '/manifest.json', '/avatars/lobe-ai.png']) {
      const r = await fetch(`${base}${p}`, { headers: html, redirect: 'manual' });
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toBe(HTML);
    }
    const n = lobeSeen.length;
    const tts = await fetch(`${base}/webapi/tts/openai`, { method: 'POST', body: '{}' });
    expect(tts.status).toBe(200);
    await tts.text();
    expect(lobeSeen.length).toBe(n + 1);
  });

  it('LobeHub 没起来时：网页显示 Aroomo「正在准备」页（自动刷新），接口仍是 502 文本', async () => {
    const dead = createShellServer(loadConfig({ LOBE_UPSTREAM: 'http://127.0.0.1:1', CORE_UPSTREAM: 'http://127.0.0.1:1' }), { session });
    const u = await listen(dead);
    const r = await fetch(`${u}/`, { headers: html });
    expect(r.status).toBe(503);
    const body = await r.text();
    expect(body).toContain('Aroomo 正在准备');
    expect(body).toContain('/aroomo/static/logo.svg');
    expect(body).toContain('http-equiv="refresh"');
    const api = await fetch(`${u}/api/x`);
    expect(api.status).toBe(502);
    await api.text();
    dead.closeAllConnections?.();
    await new Promise((res) => dead.close(res));
  });

  it('WebSocket 升级透传给 LobeHub', async () => {
    const { port } = new URL(base);
    const sock = net.connect(Number(port), '127.0.0.1');
    const got = await new Promise<string>((resolve, reject) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('101') && !buf.includes('ping')) sock.write('ping');
        if (buf.includes('ping')) resolve(buf);
      });
      sock.on('error', reject);
      sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    sock.destroy();
    expect(got).toContain('101 Switching Protocols');
    expect(got).toContain('ping');
  });
});

describe('Aroomo 页面与 /aroomo/api', () => {
  it('没登录：页面跳登录，接口 401', async () => {
    const p = await fetch(`${base}/aroomo/members`, { redirect: 'manual' });
    expect(p.status).toBe(302);
    expect(p.headers.get('location')).toBe('/signin?callbackUrl=%2Faroomo%2Fmembers');
    const a = await fetch(`${base}/aroomo/api/members`);
    expect(a.status).toBe(401);
  });

  it('已登录：页面可打开', async () => {
    const r = await fetch(`${base}/aroomo/settings/lead`, { headers: { cookie: 'session=good' } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('/aroomo/static/app.js');
  });

  it('转发到 Core：附加主人令牌，去掉 Cookie 和浏览器自带的 Authorization，保留 Access 头', async () => {
    const r = await fetch(`${base}/aroomo/api/members?deleted=true`, {
      headers: { cookie: 'session=good', authorization: 'Bearer evil', 'cf-access-jwt-assertion': 'jwt-placeholder' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toBeNull();
    const seen = coreSeen.at(-1)!;
    expect(seen.url).toBe('/api/members?deleted=true');
    expect(seen.auth).toBe('Bearer placeholder-owner-token-0123456789abcdef');
    expect(seen.cookie).toBeUndefined();
    expect(seen.access).toBe('jwt-placeholder');
  });

  it('改动类请求要带 X-Aroomo-Request 且同源', async () => {
    const n = coreSeen.length;
    const noHeader = await fetch(`${base}/aroomo/api/members`, { method: 'POST', headers: { cookie: 'session=good' }, body: '{}' });
    expect(noHeader.status).toBe(403);
    const crossSite = await fetch(`${base}/aroomo/api/members`, {
      method: 'POST',
      headers: { cookie: 'session=good', 'x-aroomo-request': '1', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
    expect(coreSeen.length).toBe(n);
    const ok = await fetch(`${base}/aroomo/api/members`, {
      method: 'POST',
      headers: { cookie: 'session=good', 'x-aroomo-request': '1', origin: base, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
  });

  it('没配置主人令牌时 503', async () => {
    const r = await fetch(`${baseNoToken}/aroomo/api/members`, { headers: { cookie: 'session=good' } });
    expect(r.status).toBe(503);
  });

  it('静态资源不能越界读文件', async () => {
    const r = await fetch(`${base}/aroomo/static/..%2f..%2fpackage.json`);
    expect(r.status).toBe(404);
    expect((await fetch(`${base}/aroomo/static/app.js`)).status).toBe(200);
  });
});

describe('退出登录（§8.3 账号）', () => {
  it('只接受同源 POST（带 X-Aroomo-Request）', async () => {
    expect((await fetch(`${base}/aroomo/logout`)).status).toBe(403);
    expect((await fetch(`${base}/aroomo/logout`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/aroomo/logout`, { method: 'POST', headers: { 'x-aroomo-request': '1', origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('替浏览器调 LobeHub 退出，带回清 Cookie；电脑版去登录页', async () => {
    lobeSignOut.length = 0;
    const res = await fetch(`${base}/aroomo/logout`, { method: 'POST', headers: { 'x-aroomo-request': '1', cookie: 'session=good' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, location: '/signin' });
    expect(res.headers.getSetCookie().join('\n')).toContain('better-auth.session_token=; Max-Age=0');
    expect(lobeSignOut).toHaveLength(1);
    expect(lobeSignOut[0]!.cookie).toBe('session=good');
  });
  it('经过 Cloudflare Access（服务器版）：下一步去 /cdn-cgi/access/logout，同时结束 Access 会话', async () => {
    const res = await fetch(`${base}/aroomo/logout`, {
      method: 'POST',
      headers: { 'x-aroomo-request': '1', cookie: 'session=good', 'cf-access-jwt-assertion': 'placeholder.jwt.value' },
    });
    expect(((await res.json()) as { location: string }).location).toBe('/cdn-cgi/access/logout');
  });
  it('没有 Cookie 时也能退出（兜底把会话 Cookie 设为过期）', async () => {
    lobeSignOut.length = 0;
    const res = await fetch(`${base}/aroomo/logout`, { method: 'POST', headers: { 'x-aroomo-request': '1' } });
    expect(res.status).toBe(200);
    expect(lobeSignOut).toHaveLength(0);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Secure-better-auth.session_token=;'))).toBe(true);
  });
  it('D190：注入用的脚本和样式已删除', async () => {
    for (const f of ['shell.js', 'shell.css', 'mention.js']) {
      const r = await fetch(`${base}/aroomo/static/${f}`);
      expect(r.status, f).toBe(404);
      await r.text();
    }
  });
});
