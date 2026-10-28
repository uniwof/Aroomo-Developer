import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { createShellServer } from '../src/server.js';
import { LobeLocalAutoLogin, safeCallback } from '../src/autologin.js';

// 假的 LobeHub：Better Auth 的 sign-in / sign-up / get-session
let lobe: Server;
let shell: Server;
let lobeUrl = '';
let base = '';
let userExists = false;
const calls: Array<{ path: string; origin?: string; body?: string }> = [];

const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  lobe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', origin: req.headers.origin as string | undefined, body });
      if (req.url === '/api/auth/sign-in/email') {
        if (!userExists) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"code":"INVALID_EMAIL_OR_PASSWORD"}');
        }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'better-auth.session_token=tok; Path=/; HttpOnly' });
        return res.end('{}');
      }
      if (req.url === '/api/auth/sign-up/email') {
        userExists = true;
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'better-auth.session_token=tok; Path=/; HttpOnly' });
        return res.end('{}');
      }
      if (req.url === '/api/auth/get-session') {
        const ok = (req.headers.cookie ?? '').includes('better-auth.session_token=tok');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(ok ? '{"user":{"id":"u1"}}' : 'null');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>x</title></head><body></body></html>');
    });
  });
  lobeUrl = await listen(lobe);
  const cfg = loadConfig({
    SHELL_HOST: '127.0.0.1',
    LOBE_UPSTREAM: lobeUrl,
    CORE_UPSTREAM: 'http://127.0.0.1:9',
    SHELL_LOCAL_OWNER_EMAIL: 'owner@aroomo.local',
    SHELL_LOCAL_OWNER_PASSWORD: 'p'.repeat(32),
    SHELL_PUBLIC_URL: 'http://localhost:3280',
  });
  shell = createShellServer(cfg);
  base = await listen(shell);
});

afterAll(async () => {
  await new Promise((r) => shell.close(r));
  await new Promise((r) => lobe.close(r));
});

describe('本机主人自动登录（独立版 D78）', () => {
  it('第一次：登录失败 → 注册 → 带会话 Cookie 跳回原页面', async () => {
    const r = await fetch(`${base}/chat?x=1`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/chat?x=1');
    const sc = r.headers.getSetCookie().join('\n');
    expect(sc).toContain('better-auth.session_token=tok');
    expect(sc).toContain('aroomo_al=1');
    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/api/auth/sign-in/email');
    expect(paths).toContain('/api/auth/sign-up/email');
    expect(calls.find((c) => c.path === '/api/auth/sign-up/email')?.origin).toBe('http://localhost:3280');
  });

  it('登录页：直接跳到 callbackUrl（只接受本站路径）', async () => {
    const r = await fetch(`${base}/signin?callbackUrl=${encodeURIComponent('/aroomo/members')}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/aroomo/members');
    const evil = await fetch(`${base}/signin?callbackUrl=${encodeURIComponent('//evil.example')}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(evil.headers.get('location')).toBe('/');
  });

  it('已登录：不再登录，正常转发', async () => {
    const r = await fetch(`${base}/chat`, { headers: { accept: 'text/html', cookie: 'better-auth.session_token=tok' }, redirect: 'manual' });
    expect(r.status).toBe(200);
  });

  it('刚自动登录过（标记 Cookie）：不再尝试，避免无限跳转', async () => {
    const r = await fetch(`${base}/chat`, { headers: { accept: 'text/html', cookie: 'aroomo_al=1' }, redirect: 'manual' });
    expect(r.status).toBe(200);
  });

  it('接口请求（非页面）不触发自动登录', async () => {
    const before = calls.length;
    const r = await fetch(`${base}/api/whatever`, { headers: { accept: 'application/json' } });
    expect(r.status).toBe(200);
    expect(calls.slice(before).some((c) => c.path.startsWith('/api/auth/sign'))).toBe(false);
  });
});

describe('配置', () => {
  it('不是本机回环地址时拒绝开启', () => {
    expect(() =>
      loadConfig({ SHELL_HOST: '0.0.0.0', SHELL_LOCAL_OWNER_EMAIL: 'a@b.c', SHELL_LOCAL_OWNER_PASSWORD: 'x'.repeat(20) }),
    ).toThrow(ConfigError);
  });
  it('只设一个时拒绝', () => {
    expect(() => loadConfig({ SHELL_HOST: '127.0.0.1', SHELL_LOCAL_OWNER_EMAIL: 'a@b.c' })).toThrow(ConfigError);
  });
  it('不设置时关闭（Docker / 服务器版）', () => {
    expect(loadConfig({}).localOwner).toBeUndefined();
  });
  it('safeCallback', () => {
    expect(safeCallback(null)).toBe('/');
    expect(safeCallback('https://evil')).toBe('/');
    expect(safeCallback('/\\evil')).toBe('/');
    expect(safeCallback('/signin?x')).toBe('/');
    expect(safeCallback('/aroomo')).toBe('/aroomo');
  });
  it('登录失败（例如密码不对、LobeHub 没起来）时返回 null', async () => {
    const al = new LobeLocalAutoLogin(new URL('http://127.0.0.1:9'), { email: 'a@b.c', password: 'x'.repeat(20) });
    expect(await al.login()).toBeNull();
  });
});
