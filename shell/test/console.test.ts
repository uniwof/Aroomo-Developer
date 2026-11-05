import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createShellServer } from '../src/server.js';
import { LobeSessionChecker, type SessionChecker } from '../src/session.js';

let shell: Server;
let base = '';
let fakeCore: Server;
let coreUrl = '';
const coreSeen: string[] = [];
let consoleDir = '';
const extra: Server[] = [];
const TOKEN = 'placeholder-owner-token-0123456789abcdef';

const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

/** 起一个用指定配置 + 会话校验器的 Shell（反向测试用） */
async function shellWith(env: Record<string, string>, session: SessionChecker): Promise<string> {
  const s = createShellServer(loadConfig({ SHELL_CONSOLE_DIR: consoleDir, CORE_UPSTREAM: coreUrl, CORE_OWNER_TOKEN: TOKEN, ...env }), { session });
  extra.push(s);
  return listen(s);
}

beforeAll(async () => {
  fakeCore = http.createServer((req, res) => {
    coreSeen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  coreUrl = await listen(fakeCore);
  const dir = mkdtempSync(path.join(tmpdir(), 'console-'));
  consoleDir = dir;
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>c</title></head><body></body></html>');
  writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  const cfg = loadConfig({ SHELL_CONSOLE_DIR: dir, CORE_UPSTREAM: coreUrl, CORE_OWNER_TOKEN: TOKEN, SHELL_OWNER_USER_ID: 'owner-id' });
  shell = createShellServer(cfg, { session: {
      check: async (c) => Boolean(c?.includes('session=')),
      userId: async (c) => (c?.includes('session=good') ? 'owner-id' : c?.includes('session=other') ? 'family-id' : undefined),
      // 邮箱和所有者一样也没用：服务器版只认用户 id
      email: async (c) => (c?.includes('session=') ? 'owner@example.com' : undefined),
    } });
  await new Promise<void>((r) => shell.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(shell.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [shell, fakeCore, ...extra]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

describe('Shell 提供控制台 /console', () => {
  it('没登录：跳登录页', async () => {
    const r = await fetch(`${base}/console/members`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/signin');
  });
  it('登录后：任意页面路径返回带 aroomo-shell 标记的 index.html；静态资源原样', async () => {
    const h = { cookie: 'session=good' };
    const page = await fetch(`${base}/console/members`, { headers: h });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<meta name="aroomo-shell" content="1">');
    const js = await fetch(`${base}/console/assets/a.js`, { headers: h });
    expect(await js.text()).toBe('console.log(1)');
  });
  it('带哈希的 assets/ 长期缓存（immutable），其他文件仍 5 分钟，页面不缓存', async () => {
    const h = { cookie: 'session=good' };
    expect((await fetch(`${base}/console/assets/a.js`, { headers: h })).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await fetch(`${base}/console/favicon.svg`, { headers: h })).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await fetch(`${base}/console/chat`, { headers: h })).headers.get('cache-control')).toBe('no-store');
  });
  it('不能用 .. 跳出目录', async () => {
    const r = await fetch(`${base}/console/..%2f..%2fetc%2fpasswd.txt`, { headers: { cookie: 'session=good' } });
    expect(r.status).toBe(404);
  });
  it('其他用户（邮箱相同也不行）访问 /console 和 /aroomo/api 和 /aroomo 都是 403', async () => {
    const h = { cookie: 'session=other', 'x-aroomo-request': '1' };
    expect((await fetch(`${base}/console/members`, { headers: h })).status).toBe(403);
    expect((await fetch(`${base}/aroomo/api/members`, { headers: h })).status).toBe(403);
    expect((await fetch(`${base}/aroomo/api/members`, { method: 'POST', headers: h })).status).toBe(403);
    expect((await fetch(`${base}/aroomo/members`, { headers: h })).status).toBe(403);
  });
  it('页面响应带 CSP frame-ancestors 和 X-Frame-Options', async () => {
    const r = await fetch(`${base}/console/members`, { headers: { cookie: 'session=good' } });
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'; default-src 'self'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });
  it('坏的百分号编码返回 404，不是 500', async () => {
    const r = await fetch(`${base}/console/%E0%A4%A`, { headers: { cookie: 'session=good' } });
    expect(r.status).toBe(404);
  });
});

describe('#245 所有者校验默认拒绝（反向测试）', () => {
  it('会话校验器没有 userId 方法：/console、/aroomo、/aroomo/api 都是 403，Core 收到 0 个请求', async () => {
    const b = await shellWith({ SHELL_OWNER_USER_ID: 'owner-id' }, { check: async (c) => Boolean(c?.includes('session=')) });
    const before = coreSeen.length;
    const h = { cookie: 'session=good', 'x-aroomo-request': '1' };
    expect((await fetch(`${b}/console/members`, { headers: h })).status).toBe(403);
    expect((await fetch(`${b}/aroomo/members`, { headers: h, redirect: 'manual' })).status).toBe(403);
    expect((await fetch(`${b}/aroomo/api/members`, { headers: h })).status).toBe(403);
    expect((await fetch(`${b}/aroomo/api/members`, { method: 'POST', headers: h })).status).toBe(403);
    expect(coreSeen.length).toBe(before);
  });

  it('只有 email 方法、没有 userId 方法：也是 403（不再按邮箱放行）', async () => {
    const b = await shellWith(
      { SHELL_OWNER_USER_ID: 'owner-id' },
      { check: async (c) => Boolean(c?.includes('session=')), email: async () => 'owner@example.com' },
    );
    const before = coreSeen.length;
    expect((await fetch(`${b}/aroomo/api/members`, { headers: { cookie: 'session=good' } })).status).toBe(403);
    expect(coreSeen.length).toBe(before);
  });

  it('家人会话访问 /aroomo/api：403，假 Core 上游收到 0 个请求；所有者会话正常转发', async () => {
    const before = coreSeen.length;
    const fam = { cookie: 'session=other', 'x-aroomo-request': '1' };
    expect((await fetch(`${base}/aroomo/api/members`, { headers: fam })).status).toBe(403);
    expect((await fetch(`${base}/aroomo/api/keys`, { method: 'POST', headers: fam, body: '{}' })).status).toBe(403);
    expect(coreSeen.length).toBe(before);
    const own = await fetch(`${base}/aroomo/api/members`, { headers: { cookie: 'session=good' } });
    expect(own.status).toBe(200);
    expect(coreSeen.length).toBe(before + 1);
  });

  it('没配 SHELL_OWNER_USER_ID（也不是独立版）：谁都 403，不再从 AUTH_ALLOWED_EMAILS / SHELL_OWNER_EMAIL 回退', async () => {
    const b = await shellWith(
      { AUTH_ALLOWED_EMAILS: 'owner@example.com', SHELL_OWNER_EMAIL: 'owner@example.com' },
      { check: async () => true, userId: async () => 'owner-id', email: async () => 'owner@example.com' },
    );
    const before = coreSeen.length;
    expect((await fetch(`${b}/aroomo/api/members`, { headers: { cookie: 'session=good' } })).status).toBe(403);
    expect((await fetch(`${b}/console/members`, { headers: { cookie: 'session=good' } })).status).toBe(403);
    expect(coreSeen.length).toBe(before);
  });

  it('生产环境 + SHELL_AUTH=off：loadConfig 抛错；非生产仍可用于测试', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SHELL_AUTH: 'off' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', SHELL_AUTH: 'off' })).toThrow(/SHELL_AUTH=off/);
    expect(loadConfig({ SHELL_AUTH: 'off' }).auth).toBe('off');
    expect(loadConfig({ NODE_ENV: 'production' }).auth).toBe('lobe-session');
    expect(loadConfig({ SHELL_OWNER_USER_ID: ' abc123 ' }).ownerUserId).toBe('abc123');
  });

  it('LobeSessionChecker 从 get-session 取 user.id 并缓存；没有 id 不算登录', async () => {
    let calls = 0;
    const f = (async (_u: URL, init: RequestInit) => {
      calls++;
      const c = (init.headers as Record<string, string>).cookie ?? '';
      const body = c.includes('good') ? { user: { id: 'u-1', email: 'A@B.C' } } : { user: { email: 'x@y.z' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const sc = new LobeSessionChecker(new URL('http://lobe.invalid'), 30_000, f, () => 1000);
    expect(await sc.userId('s=good')).toBe('u-1');
    expect(await sc.email('s=good')).toBe('a@b.c');
    expect(await sc.check('s=good')).toBe(true);
    expect(calls).toBe(1);
    expect(await sc.userId('s=noid')).toBeUndefined();
    expect(await sc.check('s=noid')).toBe(false);
    expect(await sc.userId(undefined)).toBeUndefined();
  });

  it('Windows 独立版（本机主人自动登录、没配 user id）：按本机主人邮箱比对，别的邮箱 403', async () => {
    const env = { SHELL_HOST: '127.0.0.1', SHELL_LOCAL_OWNER_EMAIL: 'Owner@aroomo.local', SHELL_LOCAL_OWNER_PASSWORD: 'p'.repeat(16), SHELL_ALLOWED_HOSTS: '127.0.0.1' };
    const mk = (email: string) => ({ check: async () => true, email: async () => email });
    const ok = await shellWith(env, mk('owner@aroomo.local'));
    const bad = await shellWith(env, mk('other@aroomo.local'));
    const noEmail = await shellWith(env, { check: async () => true });
    const h = { cookie: 'session=x' };
    expect((await fetch(`${ok}/aroomo/api/members`, { headers: h })).status).toBe(200);
    expect((await fetch(`${bad}/aroomo/api/members`, { headers: h })).status).toBe(403);
    expect((await fetch(`${noEmail}/aroomo/api/members`, { headers: h })).status).toBe(403);
  });
});
