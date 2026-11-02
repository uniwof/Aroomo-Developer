import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createShellServer } from '../src/server.js';

let shell: Server;
let base = '';

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'console-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>c</title></head><body></body></html>');
  writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
  const cfg = loadConfig({ SHELL_CONSOLE_DIR: dir, CORE_OWNER_TOKEN: 'placeholder-owner-token-0123456789abcdef', SHELL_OWNER_EMAIL: 'owner@example.com' });
  shell = createShellServer(cfg, { session: {
      check: async (c) => Boolean(c?.includes('session=')),
      email: async (c) => (c?.includes('session=good') ? 'owner@example.com' : c?.includes('session=other') ? 'other@example.com' : undefined),
    } });
  await new Promise<void>((r) => shell.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(shell.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => shell.close(r)));

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
  it('不能用 .. 跳出目录', async () => {
    const r = await fetch(`${base}/console/..%2f..%2fetc%2fpasswd.txt`, { headers: { cookie: 'session=good' } });
    expect(r.status).toBe(404);
  });
  it('其他邮箱访问 /console 和 /aroomo/api 和 /aroomo 都是 403', async () => {
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
