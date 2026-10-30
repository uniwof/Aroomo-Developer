import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await t.open(), now) })),
];

describe.each(envs)('资源库 M2（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), await env.make(clock.now));
    apps.push(app);
    const call = (headers: Record<string, string>) => (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const bearer = (t: string) => call({ authorization: `Bearer ${t}` });
    const register = async (email: string) => {
      const inv = await owner('POST', '/api/users/invites', { email });
      const r = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
      return bearer(r.json().token);
    };
    const client = async (human: ReturnType<typeof call>, scopes: string[]) => bearer((await human('POST', '/api/clients', { name: 'c', scopes })).json().token);
    return { owner, bearer, register, client, clock, app };
  }

  it('丢链接：只给 url 也行，标题默认域名；同一链接去重', async () => {
    const { owner } = await setup();
    const a = await owner('POST', '/api/library', { url: 'https://example.com/post/1#frag' });
    expect(a.statusCode).toBe(201);
    expect(a.json().item).toMatchObject({ kind: 'link', title: 'example.com', url: 'https://example.com/post/1', source: 'manual' });
    const b = await owner('POST', '/api/library', { url: 'https://example.com/post/1', title: '重复' });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ existed: true });
    expect(b.json().item.id).toBe(a.json().item.id);
    expect((await owner('GET', '/api/library')).json().items).toHaveLength(1);
  });

  it('检索：标题比正文靠前，多个词都要命中，大小写不敏感，支持中文', async () => {
    const { owner } = await setup();
    await owner('POST', '/api/library', { kind: 'article', title: '把 Postgres 当队列用', body: '讲 SKIP LOCKED 和 pg-boss', tags: ['数据库'] });
    await owner('POST', '/api/library', { kind: 'idea', title: '周末想法', body: '也许能用 postgres 做全文检索' });
    await owner('POST', '/api/library', { kind: 'article', title: '中文分词笔记', body: '结巴、PGroonga 的对比' });
    const q = async (s: string) => (await owner('GET', `/api/library?q=${encodeURIComponent(s)}`)).json().items.map((i: { title: string }) => i.title);
    expect(await q('POSTGRES')).toEqual(['把 Postgres 当队列用', '周末想法']);
    expect(await q('postgres 检索')).toEqual(['周末想法']);
    expect(await q('分词')).toEqual(['中文分词笔记']);
    expect(await q('数据库')).toEqual(['把 Postgres 当队列用']);
    expect(await q('没有这个词')).toEqual([]);
    // % 和 _ 按字面处理，不当通配符
    expect(await q('%')).toEqual([]);
    const only = (await owner('GET', '/api/library?kind=idea')).json().items;
    expect(only).toHaveLength(1);
  });

  it('拒绝：非 http 链接、带账号密码的链接、像密码 / Key 的内容、空条目', async () => {
    const { owner } = await setup();
    expect((await owner('POST', '/api/library', { url: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await owner('POST', '/api/library', { url: 'https://u:p@example.com/' })).statusCode).toBe(400);
    expect((await owner('POST', '/api/library', {})).statusCode).toBe(400);
    const s = await owner('POST', '/api/library', { title: 'x', body: '我的密码：hunter22abc' });
    expect(s.statusCode).toBe(400);
    expect(s.json().error.code ?? s.json().code).toBe('SENSITIVE_CONTENT');
    expect((await owner('GET', '/api/library')).json().items).toHaveLength(0);
  });

  it('账号之间互相看不到；账号读不到所有者的资源（越权）', async () => {
    const { owner, register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const mine = (await a('POST', '/api/library', { title: 'A 的资源', url: 'https://a.example.com/' })).json().item;
    await owner('POST', '/api/library', { title: '所有者的资源', url: 'https://o.example.com/' });
    expect((await b('GET', '/api/library')).json().items).toHaveLength(0);
    expect((await b('GET', `/api/library/${mine.id}`)).statusCode).toBe(404);
    expect((await b('DELETE', `/api/library/${mine.id}`)).statusCode).toBe(404);
    expect((await a('GET', '/api/library')).json().items.map((i: { title: string }) => i.title)).toEqual(['A 的资源']);
    // 同一个链接不同用户各存一份
    expect((await b('POST', '/api/library', { url: 'https://a.example.com/' })).statusCode).toBe(201);
  });

  it('客户端令牌：library:read 只能读，library:write 能收进但不能删；没有范围一律 403', async () => {
    const { owner, client } = await setup();
    const none = await client(owner, ['memory:read']);
    expect((await none('GET', '/api/library')).statusCode).toBe(403);
    const reader = await client(owner, ['library:read']);
    const writer = await client(owner, ['library:write']);
    expect((await reader('POST', '/api/library', { url: 'https://x.example.com/' })).statusCode).toBe(403);
    const w = await writer('POST', '/api/library', { url: 'https://x.example.com/' });
    expect(w.statusCode).toBe(201);
    expect(w.json().item.source).toBe('mcp');
    expect((await writer('GET', '/api/library')).statusCode).toBe(403);
    const id = w.json().item.id as string;
    expect((await reader('GET', '/api/library')).json().items).toHaveLength(1);
    expect((await reader('GET', `/api/library/${id}`)).json().item.url).toBe('https://x.example.com/');
    expect((await reader('DELETE', `/api/library/${id}`)).statusCode).toBe(403);
    expect((await writer('DELETE', `/api/library/${id}`)).statusCode).toBe(403);
    expect((await owner('DELETE', `/api/library/${id}`)).statusCode).toBe(204);
  });

  it('未登录 401', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/library' })).statusCode).toBe(401);
  });
});
