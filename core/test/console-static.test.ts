import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConsole, resolveConsolePath } from '../src/console/static.js';

describe('控制台静态文件 /console（D195）', () => {
  let dir: string;
  let app: FastifyInstance;
  let empty: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'aroomo-console-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Aroomo 控制台</title>');
    writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
    writeFileSync(path.join(path.dirname(dir), 'aroomo-secret-outside.txt'), 'no');
    app = Fastify();
    registerConsole(app, dir);
    await app.ready();
    empty = Fastify();
    registerConsole(empty, path.join(dir, 'missing'));
    await empty.ready();
  });
  afterAll(async () => {
    await app.close();
    await empty.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.join(path.dirname(dir), 'aroomo-secret-outside.txt'), { force: true });
  });

  it('/console 跳到 /console/，首页返回 index.html（不缓存、带安全头）', async () => {
    const r = await app.inject({ url: '/console' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/console/');
    const p = await app.inject({ url: '/console/' });
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain('Aroomo 控制台');
    expect(p.headers['cache-control']).toBe('no-store');
    expect(p.headers['content-security-policy']).toContain("script-src 'self'");
    expect(p.headers['x-frame-options']).toBe('DENY');
  });

  it('前端路由路径回落到 index.html', async () => {
    const r = await app.inject({ url: '/console/members?x=1' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('带哈希的资源长期缓存；不存在的资源 404', async () => {
    const a = await app.inject({ url: '/console/assets/index-abc.js' });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('text/javascript');
    expect(a.headers['cache-control']).toContain('immutable');
    expect((await app.inject({ url: '/console/assets/nope.js' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/console/favicon.svg' })).headers['content-type']).toBe('image/svg+xml');
  });

  it('不能越界读文件', async () => {
    for (const u of ['/console/..%2faroomo-secret-outside.txt', '/console/%2e%2e/aroomo-secret-outside.txt', '/console/%00', '/console/%E0%A4%A']) {
      const r = await app.inject({ url: u });
      expect(r.body, u).not.toBe('no');
    }
    expect(resolveConsolePath(dir, '../x')).toBe(path.join(dir, 'x'));
    expect(resolveConsolePath(dir, 'a%00b')).toBeNull();
  });

  it('没构建时 404 并说明', async () => {
    const r = await empty.inject({ url: '/console/' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('CONSOLE_NOT_BUILT');
  });
});
