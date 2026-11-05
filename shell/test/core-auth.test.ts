/**
 * SHELL_AUTH=core-session：Shell 用 Aroomo Core 账号登录（LobeHub 停用后）。
 * 用一个假 Core 跑真实的 CoreSessionChecker（不注入 session），覆盖：未登录拒绝、所有者能进、普通账号 / 别的 admin / 停用账号 403、
 * 登录和设密码只转白名单字段并带回 Cookie、退出作废会话、不往 Core 发别的 Cookie、跳转防开放重定向、配置校验。
 */
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import type { IncomingMessage } from 'node:http';
import { clientIp, createShellServer, dropCookie, safeNext } from '../src/server.js';
import { cachePut, coreSessionCookie, CoreSessionChecker } from '../src/session.js';

const TOKEN = 'placeholder-owner-token-0123456789abcdef';
const OWNER = 'owner@example.com';

// 假 Core 的会话表：Cookie 值 → 账号
const USERS: Record<string, { id: string; email: string; role: string; status: string }> = {
  owner_sess_1: { id: 'u-owner', email: 'Owner@Example.com', role: 'admin', status: 'active' },
  user_sess_01: { id: 'u-user', email: 'kid@example.com', role: 'user', status: 'active' },
  admin_other1: { id: 'u-admin2', email: 'other@example.com', role: 'admin', status: 'active' },
  owner_user_x: { id: 'u-x', email: OWNER, role: 'user', status: 'active' },
};
const revoked = new Set<string>();

let core: Server;
let shell: Server;
let base = '';
let coreUrl = '';
const seen: Array<{ method: string; url: string; cookie?: string; auth?: string; body?: string; csrf?: string; xff?: string; xri?: string }> = [];
// 假 LobeHub：记下收到的 Cookie（HTTP 和 WebSocket）
let lobe: Server;
const lobeSeen: Array<{ kind: 'http' | 'ws'; url: string; cookie?: string }> = [];

const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

function sessOf(cookie: string | undefined): string | undefined {
  const m = /(?:^|;\s*)aroomo_session=([^;]+)/.exec(cookie ?? '');
  return m && !revoked.has(m[1]!) ? m[1] : undefined;
}

beforeAll(async () => {
  core = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        cookie: req.headers.cookie,
        auth: req.headers.authorization,
        body,
        csrf: req.headers['x-aroomo-request'] as string | undefined,
        xff: req.headers['x-forwarded-for'] as string | undefined,
        xri: req.headers['x-real-ip'] as string | undefined,
      });
      const json = (status: number, b: unknown, h: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...h });
        res.end(JSON.stringify(b));
      };
      if (req.url === '/api/auth/me') {
        const s = sessOf(req.headers.cookie);
        if (!s || !USERS[s]) return json(401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } });
        return json(200, { kind: 'user', user: USERS[s] });
      }
      if (req.url === '/auth/login') {
        const b = JSON.parse(body) as { email: string; password: string; cookie?: boolean };
        if (b.email === OWNER && b.password === 'right-password')
          return json(200, { expiresAt: '2099-01-01T00:00:00Z', user: USERS.owner_sess_1, token: 'should-be-stripped' }, {
            'set-cookie': 'aroomo_session=owner_sess_1; Max-Age=100; Path=/; HttpOnly; SameSite=Strict',
          });
        return json(401, { error: { code: 'BAD_CREDENTIALS', message: '邮箱或密码不对' } });
      }
      if (req.url === '/auth/accept') {
        const b = JSON.parse(body) as { token: string };
        if (b.token === 'ari_good')
          return json(200, { expiresAt: '2099-01-01T00:00:00Z', user: USERS.owner_sess_1 }, { 'set-cookie': 'aroomo_session=owner_sess_1; Path=/; HttpOnly; SameSite=Strict' });
        return json(400, { error: { code: 'INVITE_INVALID', message: '邀请无效或已过期' } });
      }
      if (req.url === '/api/auth/logout') {
        const s = sessOf(req.headers.cookie);
        if (s && req.headers['x-aroomo-request']) revoked.add(s);
        res.writeHead(204);
        return res.end();
      }
      return json(200, { ok: true, path: req.url });
    });
  });
  coreUrl = await listen(core);
  lobe = http.createServer((req, res) => {
    lobeSeen.push({ kind: 'http', url: req.url ?? '', cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('lobe');
  });
  lobe.on('upgrade', (req, socket) => {
    lobeSeen.push({ kind: 'ws', url: req.url ?? '', cookie: req.headers.cookie });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const lobeUrl = await listen(lobe);
  const consoleDir = mkdtempSync(path.join(tmpdir(), 'console-'));
  writeFileSync(path.join(consoleDir, 'index.html'), '<!doctype html><html><head><title>c</title></head><body></body></html>');
  shell = createShellServer(
    loadConfig({ SHELL_AUTH: 'core-session', SHELL_CONSOLE_DIR: consoleDir, CORE_UPSTREAM: coreUrl, CORE_OWNER_TOKEN: TOKEN, SHELL_OWNER_EMAIL: 'OWNER@example.com', LOBE_UPSTREAM: lobeUrl, SHELL_CLIENT_IP_HEADER: 'cf-connecting-ip' }),
  );
  base = await listen(shell);
});

afterAll(async () => {
  for (const s of [shell, core, lobe]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

const get = (p: string, cookie?: string, accept = 'text/html') =>
  fetch(base + p, { redirect: 'manual', headers: { accept, ...(cookie ? { cookie } : {}) } });
const post = (p: string, body: unknown, headers: Record<string, string> = { 'x-aroomo-request': '1' }) =>
  fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('core-session：门禁', () => {
  it('未登录：/console 302 到 Aroomo 登录页（带 next），/aroomo/api 401', async () => {
    const r = await get('/console/members?x=1');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/aroomo/login?next=%2Fconsole%2Fmembers%3Fx%3D1');
    expect((await get('/aroomo/api/members', undefined, 'application/json')).status).toBe(401);
  });

  it('所有者（admin + 邮箱一致，大小写不敏感）：能开控制台；/aroomo/api 附加主人令牌、不把 Cookie 发给 Core', async () => {
    const cookie = 'aroomo_session=owner_sess_1; better-auth.session_token=lobe; other=1';
    const c = await get('/console/', cookie);
    expect(c.status).toBe(200);
    expect(await c.text()).toContain('aroomo-shell');
    seen.length = 0;
    const r = await get('/aroomo/api/members', cookie, 'application/json');
    expect(r.status).toBe(200);
    const api = seen.find((s) => s.url === '/api/members')!;
    expect(api.auth).toBe(`Bearer ${TOKEN}`);
    expect(api.cookie).toBeUndefined();
    // 会话校验只带 aroomo_session，别的 Cookie 不发给 Core
    const me = seen.find((s) => s.url === '/api/auth/me');
    if (me) expect(me.cookie).toBe('aroomo_session=owner_sess_1');
  });

  it('普通账号、别的 admin、邮箱一样但不是 admin：一律 403 NOT_OWNER', async () => {
    for (const s of ['user_sess_01', 'admin_other1', 'owner_user_x']) {
      const a = await get('/aroomo/api/members', `aroomo_session=${s}`, 'application/json');
      expect(a.status).toBe(403);
      expect(((await a.json()) as { error: { code: string } }).error.code).toBe('NOT_OWNER');
      expect((await get('/console/', `aroomo_session=${s}`)).status).toBe(403);
    }
  });

  it('伪造 / 格式不对的会话 Cookie：当未登录', async () => {
    expect((await get('/aroomo/api/x', 'aroomo_session=nope_nope_1', 'application/json')).status).toBe(401);
    expect((await get('/aroomo/api/x', 'aroomo_session=a;b', 'application/json')).status).toBe(401);
    expect(coreSessionCookie('aroomo_session=../../etc')).toBeUndefined();
  });

  it('没配 SHELL_OWNER_EMAIL：所有者也 403（默认拒绝）', async () => {
    const s = createShellServer(loadConfig({ SHELL_AUTH: 'core-session', CORE_UPSTREAM: coreUrl, CORE_OWNER_TOKEN: TOKEN }));
    const b = await listen(s);
    const r = await fetch(b + '/aroomo/api/members', { headers: { cookie: 'aroomo_session=owner_sess_1' } });
    expect(r.status).toBe(403);
    s.closeAllConnections?.();
    await new Promise((r2) => s.close(r2));
  });

  it('改动类请求仍要 X-Aroomo-Request（CSRF）', async () => {
    const r = await fetch(base + '/aroomo/api/members', { method: 'POST', headers: { cookie: 'aroomo_session=owner_sess_1' } });
    expect(r.status).toBe(403);
  });
});

describe('core-session：登录 / 设密码 / 退出', () => {
  it('登录页、设密码页不需要登录；不缓存、不带来源', async () => {
    for (const p of ['/aroomo/login', '/aroomo/accept?token=ari_good']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await r.text()).toContain('/aroomo/static/auth.js');
    }
  });

  it('登录：只转 email/password，强制 cookie:true；带回 aroomo_session，响应体不含 token', async () => {
    seen.length = 0;
    const r = await post('/aroomo/auth/login', { email: OWNER, password: 'right-password', cookie: false, role: 'admin' });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toContain('aroomo_session=owner_sess_1');
    const body = await r.text();
    expect(body).not.toContain('should-be-stripped');
    const sent = JSON.parse(seen.find((s) => s.url === '/auth/login')!.body!) as Record<string, unknown>;
    expect(sent).toEqual({ email: OWNER, password: 'right-password', cookie: true });
  });

  it('登录失败：原样给出 Core 的错误；没有 X-Aroomo-Request 一律 403', async () => {
    const r = await post('/aroomo/auth/login', { email: OWNER, password: 'wrong' });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('BAD_CREDENTIALS');
    expect((await post('/aroomo/auth/login', { email: OWNER, password: 'right-password' }, {})).status).toBe(403);
    expect((await post('/aroomo/auth/login', { email: OWNER, password: 'x' }, { 'x-aroomo-request': '1', origin: 'https://evil.example' })).status).toBe(403);
  });

  it('设密码：转 token/password，强制 cookie:true；坏令牌给出 Core 的错误', async () => {
    const ok = await post('/aroomo/auth/accept', { token: 'ari_good', password: 'a-long-password' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('aroomo_session=');
    const bad = await post('/aroomo/auth/accept', { token: 'ari_bad', password: 'a-long-password' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVITE_INVALID');
  });

  it('/aroomo/auth/session：告诉登录页是否已登录、是不是所有者；next 只留站内 /console', async () => {
    const r = (await (await get('/aroomo/auth/session?next=%2Fconsole%2Finbox', 'aroomo_session=owner_sess_1', 'application/json')).json()) as Record<string, unknown>;
    expect(r).toEqual({ loggedIn: true, owner: true, next: '/console/inbox' });
    const u = (await (await get('/aroomo/auth/session?next=https%3A%2F%2Fevil.example', 'aroomo_session=user_sess_01', 'application/json')).json()) as Record<string, unknown>;
    expect(u).toEqual({ loggedIn: true, owner: false, next: '/console/' });
    expect(safeNext('//evil.example/console')).toBe('/console/');
    expect(safeNext('/console//evil')).toBe('/console/');
    expect(safeNext('/consolex')).toBe('/console/');
    expect(safeNext('/console?tab=1')).toBe('/console?tab=1');
  });

  it('退出：带 X-Aroomo-Request 调 Core logout 作废会话，清 Cookie，回登录页；之后同一 Cookie 进不去', async () => {
    const cookie = 'aroomo_session=owner_sess_1';
    expect((await get('/console/', cookie)).status).toBe(200);
    const r = await fetch(base + '/aroomo/logout', { method: 'POST', headers: { cookie, 'x-aroomo-request': '1' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { location: string }).location).toBe('/aroomo/login');
    expect(r.headers.get('set-cookie')).toContain('aroomo_session=; Path=/; Max-Age=0');
    const lo = seen.filter((s) => s.url === '/api/auth/logout').pop()!;
    expect(lo.csrf).toBe('1');
    expect(lo.cookie).toBe(cookie);
    expect((await get('/console/', cookie)).status).toBe(302);
    revoked.delete('owner_sess_1');
  });
});

describe('core-session：不把 aroomo_session 给 LobeHub（#259 必改 1）', () => {
  it('HTTP 和 WebSocket 转给 LobeHub 前都删掉 aroomo_session，其余 Cookie 照转', async () => {
    lobeSeen.length = 0;
    const cookie = 'aroomo_session=owner_sess_1; better-auth.session_token=lobe; LOBE_LOCALE=zh-CN';
    const r = await fetch(base + '/chat/x', { headers: { cookie } });
    expect(await r.text()).toBe('lobe');
    // WebSocket：手写一个升级请求
    await new Promise<void>((resolve, reject) => {
      const u = new URL(base);
      const req = http.request({ host: u.hostname, port: u.port, path: '/ws/x', headers: { connection: 'Upgrade', upgrade: 'websocket', cookie } });
      req.on('upgrade', (_res, sock) => {
        sock.destroy();
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
    const h = lobeSeen.find((x) => x.kind === 'http')!;
    const w = lobeSeen.find((x) => x.kind === 'ws')!;
    for (const x of [h, w]) {
      expect(x.cookie).not.toContain('aroomo_session');
      expect(x.cookie).toContain('better-auth.session_token=lobe');
    }
    expect(dropCookie('aroomo_session=a', ['aroomo_session'])).toBeUndefined();
    expect(dropCookie('x=1; aroomo_session=a; y=2', ['aroomo_session'])).toBe('x=1; y=2');
  });
});

describe('core-session：登录带真实来源 IP（#259 必改 2）', () => {
  it('直连方是本机 / 容器网络：取 CF-Connecting-IP 转给 Core（X-Forwarded-For + X-Real-IP）；值不是 IP 就用直连地址', async () => {
    seen.length = 0;
    await post('/aroomo/auth/login', { email: OWNER, password: 'wrong' }, { 'x-aroomo-request': '1', 'cf-connecting-ip': '203.0.113.7' });
    const a = seen.find((s) => s.url === '/auth/login')!;
    expect(a.xff).toBe('203.0.113.7');
    expect(a.xri).toBe('203.0.113.7');
    seen.length = 0;
    await post('/aroomo/auth/login', { email: OWNER, password: 'wrong' }, { 'x-aroomo-request': '1', 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' });
    expect(seen.find((s) => s.url === '/auth/login')!.xff).toBe('127.0.0.1');
  });

  it('公网直连来的请求不信它自己填的头；没配 SHELL_CLIENT_IP_HEADER 也不信', () => {
    const req = (peer: string) => ({ socket: { remoteAddress: peer }, headers: { 'cf-connecting-ip': '198.51.100.9' } }) as unknown as IncomingMessage;
    expect(clientIp(req('203.0.113.5'), 'cf-connecting-ip')).toBe('203.0.113.5');
    expect(clientIp(req('172.18.0.4'), 'cf-connecting-ip')).toBe('198.51.100.9');
    expect(clientIp(req('::ffff:10.0.0.2'), 'cf-connecting-ip')).toBe('198.51.100.9');
    expect(clientIp(req('172.18.0.4'), undefined)).toBe('172.18.0.4');
    expect(() => loadConfig({ SHELL_CLIENT_IP_HEADER: 'x-forwarded-for' })).toThrow(ConfigError);
  });
});

describe('core-session：会话缓存', () => {
  it('缓存到期后，被停用的账号进不去（停用最多 30 秒生效，D254）', async () => {
    let t = 0;
    let active = true;
    const f = (async () =>
      new Response(JSON.stringify({ kind: 'user', user: { id: 'u1', email: 'a@b.c', role: 'admin', status: active ? 'active' : 'disabled' } }), { status: 200 })) as unknown as typeof fetch;
    const c = new CoreSessionChecker(new URL('http://core.invalid'), 30_000, f, () => t);
    expect(await c.check('aroomo_session=sess_abcdef1')).toBe(true);
    active = false;
    t = 29_000;
    expect(await c.check('aroomo_session=sess_abcdef1')).toBe(true); // 还在缓存里
    t = 30_001;
    expect(await c.check('aroomo_session=sess_abcdef1')).toBe(false);
  });

  it('缓存满了只淘汰最旧的一条，不整个清空', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) cachePut(m, `k${i}`, i, 3);
    expect([...m.keys()]).toEqual(['k2', 'k3', 'k4']);
    cachePut(m, 'k2', 9, 3); // 刷新的条目挪到最新
    cachePut(m, 'k5', 5, 3);
    expect([...m.keys()]).toEqual(['k4', 'k2', 'k5']);
  });
});

describe('core-session：配置', () => {
  it('core-session 不允许同时开 LobeHub 本机自动登录', () => {
    expect(() =>
      loadConfig({ SHELL_AUTH: 'core-session', SHELL_HOST: '127.0.0.1', SHELL_LOCAL_OWNER_EMAIL: 'a@b.c', SHELL_LOCAL_OWNER_PASSWORD: '12345678' }),
    ).toThrow(ConfigError);
  });
  it('SHELL_AUTH 只认三个值；SHELL_OWNER_EMAIL 存成小写', () => {
    expect(() => loadConfig({ SHELL_AUTH: 'nope' })).toThrow(ConfigError);
    expect(loadConfig({ SHELL_AUTH: 'core-session', SHELL_OWNER_EMAIL: 'A@B.C' }).ownerEmail).toBe('a@b.c');
  });
});
