import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { brandAsset, createShellServer } from '../src/server.js';
import { HIDDEN_PREFIXES, REDIRECTS, decideNavigation } from '../src/rules.js';
import { transformHtml } from '../src/html.js';
import type { SessionChecker } from '../src/session.js';

const HTML = '<!doctype html><html><head><title>LobeHub · 你的 AI 助手</title><link rel="icon" href="/favicon.ico?v=1"><link rel="manifest" href="/manifest.json"></head><body><div id="root"></div></body></html>';

let lobe: Server;
let core: Server;
let shell: Server;
let shellNoToken: Server;
let base = '';
let baseNoToken = '';
const coreSeen: Array<{ url: string; auth?: string; cookie?: string; access?: string }> = [];
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
  it('注入 Aroomo 的 CSS/JS、替换品牌和图标、默认简体中文', async () => {
    const res = await fetch(`${base}/`, { headers: { ...html, 'accept-encoding': 'gzip, br' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('LobeHub');
    expect(body).toContain('<title>Aroomo · 你的 AI 助手</title>');
    expect(body).toMatch(/<head><meta name="application-name" content="Aroomo">/);
    expect(body).toContain('/aroomo/static/shell.js');
    expect(body).toContain('/aroomo/static/shell.css');
    expect(body).toContain('href="/aroomo/static/favicon.ico"');
    expect(body).toContain('href="/aroomo/static/manifest.json"');
    // HTML 向上游要不压缩的版本
    expect(lobeSeen.at(-1)?.acceptEncoding).toBe('identity');
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

  it('上游仍然压缩时先解压再处理', async () => {
    const body = await (await fetch(`${base}/gz`, { headers: html })).text();
    expect(body).toContain('Aroomo · 你的 AI 助手');
  });

  it('非 HTML（接口、流式输出）原样转发', async () => {
    expect(await (await fetch(`${base}/api/data`)).text()).toBe('{"name":"LobeHub"}');
    const sse = await (await fetch(`${base}/sse`)).text();
    expect(sse).toBe('data: LobeHub 1\n\ndata: 2\n\n');
  });

  it('§8 没有的页面整页打开时跳回首页；设置跳到 Aroomo 设置', async () => {
    for (const p of ['/community', '/discover/assistant', '/image', '/memory', '/page/abc']) {
      const r = await fetch(`${base}${p}`, { headers: html, redirect: 'manual' });
      expect(r.status, p).toBe(302);
      expect(r.headers.get('location')).toBe('/');
    }
    const s = await fetch(`${base}/settings/provider`, { headers: html, redirect: 'manual' });
    expect(s.headers.get('location')).toBe('/aroomo/settings');
    // 接口请求不跳转
    const api = await fetch(`${base}/community`, { redirect: 'manual' });
    expect(api.status).toBe(200);
  });

  it('D68：朗读接口被禁用', async () => {
    const r = await fetch(`${base}/webapi/tts/openai`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
    expect(lobeSeen.some((s) => s.url.startsWith('/webapi/tts'))).toBe(false);
  });

  it('图标走 Aroomo 自己的', async () => {
    for (const p of ['/favicon.ico', '/favicon-32x32.ico', '/apple-touch-icon.png', '/manifest.json']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      await r.arrayBuffer();
    }
    const m = (await (await fetch(`${base}/manifest.json`)).json()) as { name: string; theme_color: string; icons: Array<{ src: string; sizes: string; purpose: string }> };
    expect(m.name).toBe('Aroomo');
    expect(m.theme_color).toBe('#ff7f50');
    for (const ic of m.icons) {
      const r = await fetch(`${base}${ic.src}`);
      expect(r.status, ic.src).toBe(200);
      await r.arrayBuffer();
    }
    expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
  });

  it('上游的 PWA 图标、Lobe AI 默认头像换成 Aroomo 的（不转发给 LobeHub）', async () => {
    const own = async (u: string) => Buffer.from(await (await fetch(`${base}${u}`)).arrayBuffer());
    const n = lobeSeen.length;
    expect((await own('/avatars/lobe-ai.png')).equals(await own('/aroomo/static/avatar.png'))).toBe(true);
    expect((await own('/app-icons/icon-192x192.png')).equals(await own('/aroomo/static/icon-192.png'))).toBe(true);
    expect((await own('/app-icons/icon-512x512.maskable.png')).equals(await own('/aroomo/static/icon-maskable-512.png'))).toBe(true);
    expect(lobeSeen.length).toBe(n);
    expect(brandAsset('/avatars/agent-default.png')).toBeNull();
  });

  it('HTML 里的主题色是珊瑚色，上游的 theme-color 去掉', () => {
    const out = transformHtml('<html><head><meta name="theme-color" content="#000"></head><body></body></html>');
    expect(out).toContain('<meta name="theme-color" content="#ff7f50">');
    expect(out).not.toContain('content="#000"');
    expect(out).toContain('/aroomo/static/favicon.svg');
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
    expect((await fetch(`${base}/aroomo/static/shell.js`)).status).toBe(200);
  });
});

describe('规则', () => {
  it('shell.js 与 rules.ts 的隐藏 / 跳转列表一致', () => {
    const js = readFileSync(path.resolve(__dirname, '../public/static/shell.js'), 'utf8');
    const hidden = JSON.parse(/var HIDDEN_PREFIXES = (\[[^\]]*\])/.exec(js)![1]!.replace(/'/g, '"'));
    expect(hidden).toEqual([...HIDDEN_PREFIXES]);
    const redirects = JSON.parse(
      /var REDIRECTS = (\{[^}]*\})/.exec(js)![1]!.replace(/'/g, '"').replace(/(\w+):/g, '"$1":'),
    );
    expect(redirects).toEqual(REDIRECTS);
  });

  it('首页、对话页放行', () => {
    for (const p of ['/', '/agent/inbox', '/group/x', '/signin', '/aroomo']) expect(decideNavigation(p).kind).toBe('pass');
  });

  it('品牌替换不改小写网址', () => {
    expect(transformHtml('<head></head><a href="https://lobehub.com">LobeHub</a>')).toContain('https://lobehub.com">Aroomo<');
  });
});
