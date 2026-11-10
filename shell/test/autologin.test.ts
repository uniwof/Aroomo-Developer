import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { createShellServer } from '../src/server.js';
import { AUTOLOGIN_MARK, LobeLocalAutoLogin, safeCallback, safeLocalPath } from '../src/autologin.js';

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
    // CodeQL #7：控制字符会被浏览器剥掉（/<TAB>/x → //x），一律不收
    const tab = await fetch(`${base}/signin?callbackUrl=${encodeURIComponent('/\t/evil.example')}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(tab.headers.get('location')).toBe('/');
  });

  it('跳回原页面：路径解析后以 // 开头时不外跳（CodeQL #7）', async () => {
    // fetch 会先规整路径，这里用原始请求行；/.//x 经 URL 解析后 pathname 是 //x
    for (const path of ['/.//evil.example/x', '/./\\evil.example/x']) {
      const r = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const { hostname, port } = new URL(base);
        const req = http.request({ hostname, port, path, headers: { accept: 'text/html' } }, (res) => {
          res.resume();
          resolve(res);
        });
        req.on('error', reject);
        req.end();
      });
      // 302 且带自动登录标记：确实走了自动登录分支，不是碰巧回了 /
      expect(r.statusCode).toBe(302);
      expect((r.headers['set-cookie'] ?? []).join('\n')).toContain(`${AUTOLOGIN_MARK}=1`);
      expect(r.headers.location).toBe('/');
    }
  });

  it('callbackUrl 含非 ASCII：百分号编码后跳转，服务不受影响（#357 M2）', async () => {
    const r = await fetch(`${base}/signin?callbackUrl=%2F%E4%B8%AD`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/%E4%B8%AD');
    const next = await fetch(`${base}/chat?x=1`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(next.status).toBe(302);
    expect(next.headers.get('location')).toBe('/chat?x=1');
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
    expect(safeCallback('/\t/evil')).toBe('/');
    expect(safeCallback('/\n/evil')).toBe('/');
    expect(safeCallback('/aroomo')).toBe('/aroomo');
  });
  it('登录失败（例如密码不对、LobeHub 没起来）时返回 null', async () => {
    const al = new LobeLocalAutoLogin(new URL('http://127.0.0.1:9'), { email: 'a@b.c', password: 'x'.repeat(20) });
    expect(await al.login()).toBeNull();
  });
});

import { hostAllowed } from '../src/server.js';
describe('D80-2 Host 白名单', () => {
  it('本机自动登录时默认只认 localhost / 127.0.0.1', () => {
    const c = loadConfig({ SHELL_HOST: '127.0.0.1', SHELL_LOCAL_OWNER_EMAIL: 'o@aroomo.local', SHELL_LOCAL_OWNER_PASSWORD: 'p'.repeat(16) });
    expect(c.allowedHosts).toEqual(['localhost', '127.0.0.1']);
    expect(hostAllowed('127.0.0.1:3000', c.allowedHosts!)).toBe(true);
    expect(hostAllowed('localhost:3000', c.allowedHosts!)).toBe(true);
    expect(hostAllowed('evil.example.com:3000', c.allowedHosts!)).toBe(false);
    expect(hostAllowed('127.0.0.1.evil.com', c.allowedHosts!)).toBe(false);
    expect(hostAllowed(undefined, c.allowedHosts!)).toBe(false);
  });
  it('服务器版不限制', () => {
    expect(loadConfig({}).allowedHosts).toBeUndefined();
  });
});

describe('safeLocalPath 穷举（#357 M1/M2）', () => {
  // 小字母表上穷举长度 ≤5 的所有串
  const ALPHA = ['/', '\\', '.', '\t', '\n', '\r', 'a', ':', '@', '%', ' ', '中'];
  // 负责人第 2 轮补：NUL、US、DEL、全角空格、全角斜杠、? 、#。与原字母表合并后穷举到长度 ≤4（≤5 太慢）
  const EXTRA = ['\x00', '\x1f', '\x7f', '\u3000', '\uFF0F', '?', '#'];
  function* strings(max: number, alpha: readonly string[] = ALPHA): Generator<string> {
    let layer = [''];
    for (let n = 1; n <= max; n++) {
      layer = layer.flatMap((s) => alpha.map((c) => s + c));
      yield* layer;
    }
  }
  const BASE = 'http://host.test';
  const hostOf = (s: string) => {
    try {
      return new URL(s, BASE).host;
    } catch {
      return null;
    }
  };

  it('结果要么是 /，要么解析后仍在本站，且只含 U+0021–U+007E；同一判据在原始输入上能找到外跳', () => {
    const offSite: string[] = [];
    const nonAscii: string[] = [];
    let rawEscapes = 0;
    for (const s of strings(5)) {
      const h = hostOf(s);
      if (h !== null && h !== 'host.test') rawEscapes++;
      const out = safeLocalPath(s);
      if (out !== '/' && hostOf(out) !== 'host.test') offSite.push(JSON.stringify(s));
      if (!/^[\x21-\x7e]+$/.test(out)) nonAscii.push(JSON.stringify(s));
    }
    expect(offSite.slice(0, 5)).toEqual([]);
    expect(nonAscii.slice(0, 5)).toEqual([]);
    expect(rawEscapes).toBeGreaterThan(0); // 判据不是恒真
  });

  it('补充字符（\\x00 \\x1f \\x7f \\u3000 \\uFF0F ? #）与原字母表组合穷举到长度 ≤4，同一判据', () => {
    const offSite: string[] = [];
    const nonAscii: string[] = [];
    let rawEscapes = 0;
    for (const s of strings(4, [...ALPHA, ...EXTRA])) {
      const h = hostOf(s);
      if (h !== null && h !== 'host.test') rawEscapes++;
      const out = safeLocalPath(s);
      if (out !== '/' && hostOf(out) !== 'host.test') offSite.push(JSON.stringify(s));
      if (!/^[\x21-\x7e]+$/.test(out)) nonAscii.push(JSON.stringify(s));
    }
    expect(offSite.slice(0, 5)).toEqual([]);
    expect(nonAscii.slice(0, 5)).toEqual([]);
    expect(rawEscapes).toBeGreaterThan(0);
  });

  it('显式用例：控制字符一律回 /', () => {
    for (const c of ['\x00', '\x1f', '\x7f', '\r', '\t\\']) {
      expect(safeLocalPath(c)).toBe('/');
      expect(safeLocalPath(`/${c}`)).toBe('/');
      expect(safeLocalPath(`/${c}/evil.example`)).toBe('/');
    }
  });

  it('显式用例：%2F%2F、全角空格、全角斜杠、/.//evil 按同源判据', () => {
    const sameOrigin = (out: string) => out === '/' || hostOf(out) === 'host.test';
    for (const s of ['/%2F%2Fevil.example', '%2F%2Fevil.example', '/\u3000/evil.example', '\u3000//evil.example', '/\uFF0F/evil.example', '/\uFF0Fevil.example', '\uFF0F\uFF0Fevil.example', '/.//evil.example', '/.//evil.example/x']) {
      const out = safeLocalPath(s);
      expect(sameOrigin(out), `${JSON.stringify(s)} → ${out}`).toBe(true);
      expect(out).toMatch(/^[\x21-\x7e]+$/);
    }
  });
});
