/**
 * 白名单直通 Core（负责人 2026-11-05 19:47 裁定，PR #264）：浏览器在 Shell 同源 POST /api/chat/stream，
 * Shell 只带会话 Cookie + CSRF 头 + content-type/accept + 真实来源 IP 转给 Core，不带主人令牌、不带 Authorization，
 * 流式不缓冲，浏览器断开立刻中止上游；白名单外的路径 Core 收不到。
 */
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CORE_COOKIE_ROUTES, consoleRedirect, coreCookieRouteMethods, createShellServer } from '../src/server.js';

const TOKEN = 'placeholder-owner-token-0123456789abcdef';
const GOOD = 'user_sess_01';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let core: Server;
let lobe: Server;
let shell: Server;
let base = '';
const coreSeen: Seen[] = [];
const lobeSeen: string[] = [];
/** 假 Core 的流：断开时记下 */
let upstreamClosed: (() => void) | undefined;
let upstreamAborted = false;

const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  core = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      coreSeen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      // 照真 Core 的规矩：没有有效会话 401、Cookie 会话缺 CSRF 头 403、带 Authorization 401
      const m = /(?:^|;\s*)(?:__Host-)?aroomo_session=([^;]+)/.exec(req.headers.cookie ?? '');
      if (req.headers.authorization || !m || m[1] !== GOOD) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '请先登录' } }));
      }
      if (!req.headers['x-aroomo-request']) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'CSRF', message: 'csrf' } }));
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'set-cookie': 'aroomo_session=evil; Path=/',
      });
      res.write('data: {"type":"start"}\n\n');
      if (!req.url?.includes('hang')) {
        res.write('data: {"type":"text-delta","id":"t","delta":"你好"}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      // 挂着不结束：等浏览器断开
      res.on('close', () => {
        upstreamAborted = !res.writableEnded;
        upstreamClosed?.();
      });
    });
  });
  const coreUrl = await listen(core);
  lobe = http.createServer((req, res) => {
    lobeSeen.push(`${req.method} ${req.url}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"lobehub_stopped"}');
  });
  const lobeUrl = await listen(lobe);
  shell = createShellServer(
    loadConfig({
      SHELL_AUTH: 'core-session',
      CORE_UPSTREAM: coreUrl,
      CORE_OWNER_TOKEN: TOKEN,
      SHELL_OWNER_EMAIL: 'owner@example.com',
      LOBE_UPSTREAM: lobeUrl,
      SHELL_CLIENT_IP_HEADER: 'cf-connecting-ip',
    }),
  );
  base = await listen(shell);
});

afterAll(async () => {
  for (const s of [shell, core, lobe]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

beforeEach(() => {
  coreSeen.length = 0;
  lobeSeen.length = 0;
  upstreamAborted = false;
  upstreamClosed = undefined;
});

const chat = (headers: Record<string, string>, p = '/api/chat/stream', method = 'POST') =>
  fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ model: 'aroomo', messages: [{ role: 'user', content: 'hi' }] }) }),
  });

describe('白名单直通 Core：POST /api/chat/stream', () => {
  it('白名单是逐条列出的精确路径，第 1 批只有 POST /api/chat/stream', () => {
    expect(CORE_COOKIE_ROUTES).toEqual([{ method: 'POST', path: '/api/chat/stream' }]);
    expect(coreCookieRouteMethods('/api/chat/stream')).toEqual(['POST']);
    expect(coreCookieRouteMethods('/api/chat/stream/')).toBeUndefined();
    expect(coreCookieRouteMethods('/api/chat')).toBeUndefined();
    expect(coreCookieRouteMethods('/api/members')).toBeUndefined();
  });

  it('没登录（没有会话 Cookie）：401，Core 和 LobeHub 都收不到', async () => {
    const r = await chat({ 'x-aroomo-request': '1', cookie: 'other=1' });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(coreSeen).toHaveLength(0);
    expect(lobeSeen).toHaveLength(0);
  });

  it('会话无效：Core 判 401，原样返回', async () => {
    const r = await chat({ 'x-aroomo-request': '1', cookie: '__Host-aroomo_session=expired_sess_9' });
    expect(r.status).toBe(401);
    expect(coreSeen).toHaveLength(1);
  });

  it('缺 CSRF 头：403，不转给 Core；跨站 Origin 也 403', async () => {
    const r = await chat({ cookie: `__Host-aroomo_session=${GOOD}` });
    expect(r.status).toBe(403);
    const r2 = await chat({ cookie: `__Host-aroomo_session=${GOOD}`, 'x-aroomo-request': '1', origin: 'https://evil.example' });
    expect(r2.status).toBe(403);
    expect(coreSeen).toHaveLength(0);
  });

  it('转过去的请求只带会话 Cookie 和白名单头：没有令牌、没有 Authorization、没有别的 Cookie；来源 IP 用 Shell 自己判的；Set-Cookie 删掉', async () => {
    const r = await chat({
      'x-aroomo-request': '1',
      cookie: `better-auth.session_token=lobe; __Host-aroomo_session=${GOOD}; aroomo_session=old_sess_1; other=1`,
      authorization: `Bearer ${TOKEN}`,
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '6.6.6.6',
      'cf-access-jwt-assertion': 'jwt',
      'x-api-key': 'k',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await r.text()).toContain('你好');
    expect(coreSeen).toHaveLength(1);
    const h = coreSeen[0]!.headers;
    expect(coreSeen[0]!.method).toBe('POST');
    expect(coreSeen[0]!.url).toBe('/api/chat/stream');
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBe(`__Host-aroomo_session=${GOOD}`);
    expect(h['x-aroomo-request']).toBe('1');
    expect(h['content-type']).toBe('application/json');
    expect(h.accept).toBe('text/event-stream');
    // 127.0.0.1 直连是可信上一跳：取 CF-Connecting-IP，不拼浏览器自己填的 X-Forwarded-For
    expect(h['x-forwarded-for']).toBe('203.0.113.7');
    expect(h['x-real-ip']).toBe('203.0.113.7');
    expect(h['cf-access-jwt-assertion']).toBeUndefined();
    expect(h['x-api-key']).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(TOKEN);
    expect(coreSeen[0]!.body).toContain('"model":"aroomo"');
  });

  it('过渡期旧名 Cookie 也能用', async () => {
    const r = await chat({ 'x-aroomo-request': '1', cookie: `aroomo_session=${GOOD}` });
    expect(r.status).toBe(200);
    expect(coreSeen[0]!.headers.cookie).toBe(`aroomo_session=${GOOD}`);
    await r.text();
  });

  it('流式逐块到达（不等上游结束），浏览器断开立刻中止上游', async () => {
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const ac = new AbortController();
    const r = await fetch(base + '/api/chat/stream?hang=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aroomo-request': '1', cookie: `__Host-aroomo_session=${GOOD}` },
      body: '{}',
      signal: ac.signal,
    });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"start"');
    ac.abort();
    await closed;
    expect(upstreamAborted).toBe(true);
  });

  it('白名单外的路径和方法：Core 收不到', async () => {
    const cookie = `__Host-aroomo_session=${GOOD}`;
    const g = await chat({ 'x-aroomo-request': '1', cookie }, '/api/chat/stream', 'GET');
    expect(g.status).toBe(405);
    expect(g.headers.get('allow')).toBe('POST');
    for (const p of ['/api/members', '/api/chat/stream/x', '/api/chat', '/api/auth/me', '/api/keys']) {
      await chat({ 'x-aroomo-request': '1', cookie }, p);
    }
    expect(coreSeen).toHaveLength(0);
    expect(lobeSeen).toHaveLength(5);
  });
});

describe('core-session：裸地址跳到新界面 /console/*', () => {
  const get = (p: string, method = 'GET') => fetch(base + p, { method, redirect: 'manual', headers: { accept: 'text/html' } });
  it('/ → /console/chat；各入口带子路径和查询串原样跳过去（302），LobeHub 收不到', async () => {
    const cases: [string, string][] = [
      ['/', '/console/chat'],
      ['/?x=1', '/console/chat?x=1'],
      ['/chat', '/console/chat'],
      ['/chat/abc?member=m1&q=%E4%BD%A0', '/console/chat/abc?member=m1&q=%E4%BD%A0'],
      ['/team', '/console/team'],
      ['/hub/x/y', '/console/hub/x/y'],
      ['/inbox?tab=open', '/console/inbox?tab=open'],
      ['/settings/', '/console/settings/'],
      ['/settings/keys', '/console/settings/keys'],
      ['/assistants/a1', '/console/assistants/a1'],
    ];
    for (const [from, to] of cases) {
      const r = await get(from);
      expect(r.status, from).toBe(302);
      expect(r.headers.get('location'), from).toBe(to);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const h = await get('/team?x=2', 'HEAD');
    expect(h.status).toBe(302);
    expect(h.headers.get('location')).toBe('/console/team?x=2');
    expect(lobeSeen).toHaveLength(0);
    expect(coreSeen).toHaveLength(0);
  });
  it('只匹配整段：/chats、/teamx、/settingsx、/api/*、/console/* 不跳', async () => {
    for (const p of ['/chats', '/teamx', '/settingsx', '/hubs/x', '/api/chat/stream', '/api/members', '/console/chat', '/aroomo/login']) {
      expect(consoleRedirect(p), p).toBeUndefined();
    }
    const r = await get('/chats');
    expect(r.status).toBe(404); // 落到 LobeHub（假上游 404）
    expect(lobeSeen).toEqual(['GET /chats']);
  });
  it('非 GET/HEAD 不跳（照旧给 LobeHub）；D256 白名单 /api/chat/stream 不受影响', async () => {
    const r = await fetch(base + '/chat', { method: 'POST', redirect: 'manual', body: '{}' });
    expect(r.status).toBe(404);
    expect(lobeSeen).toEqual(['POST /chat']);
    const c = await chat({ 'x-aroomo-request': '1', cookie: `__Host-aroomo_session=${GOOD}` });
    expect(c.status).toBe(200);
    await c.text();
    expect(coreSeen).toHaveLength(1);
  });
});

describe('lobe-session 下不开直通', () => {
  it('POST /api/chat/stream 照旧给 LobeHub，Core 收不到', async () => {
    const coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
    const lobeUrl = `http://127.0.0.1:${(lobe.address() as AddressInfo).port}`;
    const s = createShellServer(loadConfig({ SHELL_AUTH: 'lobe-session', CORE_UPSTREAM: coreUrl, LOBE_UPSTREAM: lobeUrl }), {
      session: { check: async () => true },
    });
    const b = await listen(s);
    const r = await fetch(b + '/api/chat/stream', { method: 'POST', headers: { 'x-aroomo-request': '1', cookie: `aroomo_session=${GOOD}` }, body: '{}' });
    expect(r.status).toBe(404);
    expect(coreSeen).toHaveLength(0);
    expect(lobeSeen).toEqual(['POST /api/chat/stream']);
    // 裸地址在 lobe-session 下是 LobeHub 自己的页面：不跳
    const g = await fetch(b + '/chat?x=1', { redirect: 'manual' });
    expect(g.status).toBe(404);
    expect(lobeSeen).toEqual(['POST /api/chat/stream', 'GET /chat?x=1']);
    s.closeAllConnections?.();
    await new Promise((r2) => s.close(r2));
  });
});
