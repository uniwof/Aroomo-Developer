import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { hmacToken, type MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { OWNER_TOKEN, TOKEN_SECRET, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await t.open(), now) })),
];

describe.each(envs)('公共记忆 B6（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
    apps.push(app);
    const call = (headers: Record<string, string>) => (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const bearer = (t: string) => call({ authorization: `Bearer ${t}` });
    const register = async (email: string) => {
      const inv = await owner('POST', '/api/users/invites', { email });
      const r = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
      return bearer(r.json().token);
    };
    const client = async (human: ReturnType<typeof call>, scopes: string[]) =>
      bearer((await human('POST', '/api/clients', { name: 'c', scopes })).json().token);
    return { owner, bearer, register, client, clock };
  }

  it('写入 → 读取 → 更新版本递增；列表只有摘要', async () => {
    const { owner } = await setup();
    const w = await owner('PUT', '/api/memory/prefs', { title: '偏好', body: '回答简短，用中文。' });
    expect(w.statusCode).toBe(200);
    expect(w.json().memory).toMatchObject({ topic: 'prefs', version: 1 });
    expect((await owner('PUT', '/api/memory/prefs', { title: '偏好', body: '回答简短，用中文，别用表情。' })).json().memory.version).toBe(2);
    const list = (await owner('GET', '/api/memory')).json().topics;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('body');
    expect((await owner('GET', '/api/memory/prefs')).json().memory.body).toContain('别用表情');
    expect((await owner('GET', '/api/memory/nope')).statusCode).toBe(404);
    expect((await owner('PUT', '/api/memory/Bad Topic', { title: 't', body: 'b' })).statusCode).toBe(400);
  });

  it('版本历史与回滚（回滚是写新版本，历史不丢）', async () => {
    const { owner } = await setup();
    await owner('PUT', '/api/memory/rules', { title: '规矩', body: 'v1 内容' });
    await owner('PUT', '/api/memory/rules', { title: '规矩', body: 'v2 内容' });
    await owner('PUT', '/api/memory/rules', { title: '规矩', body: 'v3 内容' });
    const vs = (await owner('GET', '/api/memory/rules/versions')).json().versions;
    expect(vs.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const rb = await owner('POST', '/api/memory/rules/rollback', { version: 1 });
    expect(rb.json().memory).toMatchObject({ version: 4, body: 'v1 内容' });
    expect((await owner('GET', '/api/memory/rules/versions')).json().versions).toHaveLength(3);
    expect((await owner('POST', '/api/memory/rules/rollback', { version: 99 })).statusCode).toBe(404);
  });

  it('疑似密码 / Key / 卡号的内容不让存', async () => {
    const { owner } = await setup();
    const fake = ['sk', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
    const r = await owner('PUT', '/api/memory/x', { title: '笔记', body: `我的 key 是 ${fake}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SENSITIVE_CONTENT');
    expect((await owner('PUT', '/api/memory/x', { title: '笔记', body: '密码：hunter2hunter2' })).statusCode).toBe(400);
    expect((await owner('GET', '/api/memory/x')).statusCode).toBe(404);
  });

  it('用户之间互相看不见；同主题名不冲突；B 删不了 A 的', async () => {
    const { owner, register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    await a('PUT', '/api/memory/prefs', { title: 'A 的偏好', body: 'A 喜欢蓝色' });
    await b('PUT', '/api/memory/prefs', { title: 'B 的偏好', body: 'B 喜欢红色' });
    expect((await a('GET', '/api/memory/prefs')).json().memory.body).toBe('A 喜欢蓝色');
    expect((await b('GET', '/api/memory/prefs')).json().memory.body).toBe('B 喜欢红色');
    expect((await owner('GET', '/api/memory')).json().topics).toEqual([]);
    await a('PUT', '/api/memory/only-a', { title: '仅 A', body: 'x' });
    expect((await b('GET', '/api/memory/only-a')).statusCode).toBe(404);
    expect((await b('DELETE', '/api/memory/only-a')).statusCode).toBe(404);
    expect((await b('GET', '/api/memory/only-a/versions')).statusCode).toBe(404);
    expect((await a('GET', '/api/memory/only-a')).statusCode).toBe(200);
  });

  it('客户端令牌：有 memory:read 才能读，且只读创建者的数据；不能写、不能看版本', async () => {
    const { owner, register, client } = await setup();
    const a = await register('a@example.com');
    await a('PUT', '/api/memory/prefs', { title: 'A', body: 'A 的内容' });
    await owner('PUT', '/api/memory/prefs', { title: 'Owner', body: '所有者的内容' });
    const ca = await client(a, ['memory:read']);
    expect((await ca('GET', '/api/memory/prefs')).json().memory.body).toBe('A 的内容');
    expect((await ca('GET', '/api/memory')).json().topics).toHaveLength(1);
    expect((await ca('PUT', '/api/memory/prefs', { title: 'x', body: 'hack' })).statusCode).toBe(403);
    expect((await ca('DELETE', '/api/memory/prefs')).statusCode).toBe(403);
    expect((await ca('GET', '/api/memory/prefs/versions')).statusCode).toBe(403);
    expect((await ca('POST', '/api/memory/prefs/rollback', { version: 1 })).statusCode).toBe(403);
    // 没有 memory:read 范围
    const cb = await client(a, ['bookmarks:read']);
    expect((await cb('GET', '/api/memory')).statusCode).toBe(403);
    expect((await cb('GET', '/api/memory/prefs')).statusCode).toBe(403);
    // 所有者名下的客户端读到的是所有者的
    const co = await client(owner, ['memory:read']);
    expect((await co('GET', '/api/memory/prefs')).json().memory.body).toBe('所有者的内容');
    // A 的数据没被改
    expect((await a('GET', '/api/memory/prefs')).json().memory.body).toBe('A 的内容');
  });

  it('吊销客户端后立刻读不了；删除记忆连同历史', async () => {
    const { owner, bearer } = await setup();
    await owner('PUT', '/api/memory/p', { title: 't', body: 'b1' });
    await owner('PUT', '/api/memory/p', { title: 't', body: 'b2' });
    const made = (await owner('POST', '/api/clients', { name: 'c', scopes: ['memory:read'] })).json();
    expect((await bearer(made.token)('GET', '/api/memory/p')).statusCode).toBe(200);
    await owner('DELETE', `/api/clients/${made.client.id}`);
    expect((await bearer(made.token)('GET', '/api/memory/p')).statusCode).toBe(401);
    expect((await owner('DELETE', '/api/memory/p')).statusCode).toBe(204);
    expect((await owner('GET', '/api/memory/p')).statusCode).toBe(404);
    expect((await owner('PUT', '/api/memory/p', { title: 't', body: 'again' })).json().memory.version).toBe(1);
  });

  it('操作员令牌（即使有 members:read）不能用公共记忆接口', async () => {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    (deps.operatorTokens as MemoryOperatorTokenStore).add({
      id: 'op', hmac: hmacToken(TOKEN_SECRET, 'placeholder-op-token'), capabilities: ['members:read', 'inbox:read'], revokedAt: null, expiresAt: null,
    });
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_ACCESS_REAUTH: 'off' }), deps);
    apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/memory/p', headers: ownerAuth, payload: { title: 't', body: 'b' } });
    const op = { authorization: 'Bearer placeholder-op-token' };
    expect((await app.inject({ method: 'GET', url: '/api/members', headers: op })).statusCode).toBe(200); // 令牌本身有效
    expect((await app.inject({ method: 'GET', url: '/api/memory', headers: op })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/memory/p', headers: op, payload: { title: 't', body: 'x' } })).statusCode).toBe(403);
  });
});
