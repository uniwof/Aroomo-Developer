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

describe.each(envs)('客户端令牌 B3（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
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
    return { app, clock, owner, bearer, register };
  }

  it('人创建客户端令牌：明文只出现一次，列表里没有；客户端能看自己', async () => {
    const { owner, bearer } = await setup();
    const c = await owner('POST', '/api/clients', { name: '我的脚本', scopes: ['bookmarks:read', 'memory:read'] });
    expect(c.statusCode).toBe(201);
    const { token, client } = c.json();
    expect(token).toMatch(/^arc_/);
    expect(JSON.stringify((await owner('GET', '/api/clients')).json())).not.toContain(token);
    expect((await owner('GET', '/api/clients')).json().clients[0]).toMatchObject({ id: client.id, name: '我的脚本', revokedAt: null });
    const me = await bearer(token)('GET', '/api/clients/self');
    expect(me.statusCode).toBe(200);
    expect(me.json().client).toEqual({ id: client.id, name: '我的脚本', scopes: ['bookmarks:read', 'memory:read'] });
  });

  it('范围是白名单：空 / 未知范围被拒', async () => {
    const { owner } = await setup();
    expect((await owner('POST', '/api/clients', { name: 'x', scopes: [] })).json().error.code).toBe('NO_SCOPES');
    expect((await owner('POST', '/api/clients', { name: 'x', scopes: ['vault:read'] })).json().error.code).toBe('UNKNOWN_SCOPE');
    expect((await owner('POST', '/api/clients', { name: 'x', scopes: ['tools:call:any'] })).json().error.code).toBe('UNKNOWN_SCOPE');
  });

  it('客户端令牌不能访问任何业务接口，也不能管理令牌 / 账号；拒绝会审计', async () => {
    const { owner, bearer } = await setup();
    const { token } = (await owner('POST', '/api/clients', { name: 'c', scopes: ['bookmarks:read'] })).json();
    const c = bearer(token);
    for (const url of ['/api/members', '/api/keys', '/api/inbox', '/api/audit', '/api/settings/lead', '/api/users', '/api/clients', '/api/auth/me']) {
      expect((await c('GET', url)).statusCode, url).toBe(403);
    }
    expect((await c('POST', '/api/clients', { name: 'sneaky', scopes: ['memory:read'] })).statusCode).toBe(403);
    const audit = (await owner('GET', '/api/audit?action=auth.denied')).json();
    expect(audit.entries.some((e: { actor: { type: string } }) => e.actor.type === 'client')).toBe(true);
  });

  it('吊销立即生效；别人的令牌表现为不存在；吊销全部', async () => {
    const { owner, bearer, register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const ta = (await a('POST', '/api/clients', { name: 'A 的客户端', scopes: ['memory:read'] })).json();
    expect((await bearer(ta.token)('GET', '/api/clients/self')).statusCode).toBe(200);
    // B 看不到、吊销不了 A 的
    expect((await b('GET', '/api/clients')).json().clients).toEqual([]);
    expect((await b('DELETE', `/api/clients/${ta.client.id}`)).statusCode).toBe(404);
    expect((await owner('DELETE', `/api/clients/${ta.client.id}`)).statusCode).toBe(404);
    expect((await bearer(ta.token)('GET', '/api/clients/self')).statusCode).toBe(200);
    // A 自己吊销 → 下一次请求就 401
    expect((await a('DELETE', `/api/clients/${ta.client.id}`)).statusCode).toBe(204);
    expect((await bearer(ta.token)('GET', '/api/clients/self')).statusCode).toBe(401);
    // 吊销全部
    const t1 = (await a('POST', '/api/clients', { name: '1', scopes: ['memory:read'] })).json().token;
    const t2 = (await a('POST', '/api/clients', { name: '2', scopes: ['memory:read'] })).json().token;
    expect((await a('POST', '/api/clients/revoke-all')).json().revoked).toBe(2);
    expect((await bearer(t1)('GET', '/api/clients/self')).statusCode).toBe(401);
    expect((await bearer(t2)('GET', '/api/clients/self')).statusCode).toBe(401);
  });

  it('客户端归属：令牌带着创建者的 user_id，所有者看不到账号用户的客户端', async () => {
    const { owner, bearer, register } = await setup();
    const a = await register('a@example.com');
    const t = (await a('POST', '/api/clients', { name: 'A', scopes: ['brief:read'] })).json();
    const mine = (await owner('GET', '/api/clients')).json().clients;
    expect(mine).toEqual([]); // 所有者看不到 A 的客户端（所有者令牌的数据归 owner）
    expect((await bearer(t.token)('GET', '/api/clients/self')).json().client.name).toBe('A');
  });

  it('过期的令牌无效；每分钟超限 429，下一分钟恢复', async () => {
    const { owner, bearer, clock } = await setup();
    const exp = (await owner('POST', '/api/clients', { name: 'e', scopes: ['memory:read'], expiresInDays: 1 })).json().token;
    const lim = (await owner('POST', '/api/clients', { name: 'l', scopes: ['memory:read'], rateLimitPerMin: 3 })).json().token;
    expect((await bearer(exp)('GET', '/api/clients/self')).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await bearer(lim)('GET', '/api/clients/self')).statusCode).toBe(200);
    expect((await bearer(lim)('GET', '/api/clients/self')).statusCode).toBe(429);
    clock.advance(61_000);
    expect((await bearer(lim)('GET', '/api/clients/self')).statusCode).toBe(200);
    clock.advance(25 * 3600_000);
    expect((await bearer(exp)('GET', '/api/clients/self')).statusCode).toBe(401);
  });

  it('审计里没有令牌明文', async () => {
    const { owner } = await setup();
    const { token } = (await owner('POST', '/api/clients', { name: 'c', scopes: ['memory:read'] })).json();
    expect(JSON.stringify((await owner('GET', '/api/audit?limit=200')).json())).not.toContain(token);
  });
});
