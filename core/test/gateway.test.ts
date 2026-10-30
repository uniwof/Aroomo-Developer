/** 工具网关（A 类：spend / danger 确认、鉴权、隔离）。 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const VAULT_KEY = randomBytes(32).toString('base64');
const SECRET = 'sk-test-AAAA1111BBBB2222CCCC3333';

const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await t.open(), now) })),
];

describe.each(envs)('工具网关（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', VAULT_KEY }), deps);
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
    /** 走完重要确认再发；send 收到确认令牌 */
    const confirmed = async (send: (confirmToken?: string) => ReturnType<typeof owner>) => {
      const first = await send();
      if (first.statusCode !== 428) return first;
      const ch = first.json().error.confirm;
      expect((await owner('POST', ch.stepUrl, { step: 1 })).statusCode).toBe(200);
      clock.advance(3000);
      const s2 = await owner('POST', ch.stepUrl, { step: 2 });
      expect(s2.statusCode).toBe(200);
      return send(s2.json().confirmToken);
    };
    const secretId = async () => (await owner('POST', '/api/vault', { name: 'site-login', kind: 'password', value: SECRET })).json().secret.id as string;
    const taskCount = async () => (await owner('GET', '/api/tasks')).json().tasks.length as number;
    return { owner, bearer, register, confirmed, secretId, taskCount, deps, app };
  }

  const httpDef = {
    toolId: 'paid_search',
    name: '付费搜索',
    baseUrl: 'https://api.example.com/v1',
    auth: { type: 'bearer', secretId: '' },
    allowedHosts: ['api.example.com'],
    risk: 'spend',
    perDayLimit: 10,
    enabled: true,
  };

  it('工具列表有执行员三件套，带风险级别', async () => {
    const { owner } = await setup();
    const r = await owner('GET', '/api/gateway/tools');
    expect(r.statusCode).toBe(200);
    const byName = Object.fromEntries(r.json().tools.map((t: { name: string; risk: string }) => [t.name, t.risk]));
    expect(byName).toMatchObject({ read_webpage: 'read', browser_task_create: 'write', browser_task_status: 'read', browser_task_cancel: 'write' });
  });

  it('普通任务（不带凭据）直接执行；带凭据的登录任务 → 428，没确认前一个任务也没建，确认后才建', async () => {
    const { owner, confirmed, secretId, taskCount } = await setup();
    const ok = await owner('POST', '/api/gateway/call', { tool: 'browser_task_create', args: { kind: 'checkin', site: 'https://example.com/' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().isError).toBeFalsy();
    expect(await taskCount()).toBe(1);

    const sid = await secretId();
    const args = { kind: 'login', site: 'https://example.com/', secrets: [{ secretId: sid, field: 'password' }] };
    const first = await owner('POST', '/api/gateway/call', { tool: 'browser_task_create', args });
    expect(first.statusCode).toBe(428);
    expect(first.json().error.confirm.kind).toBe('irreversible');
    expect(first.body).not.toContain(SECRET);
    expect(await taskCount()).toBe(1);

    const done = await confirmed((confirmToken) => owner('POST', '/api/gateway/call', { tool: 'browser_task_create', args, ...(confirmToken ? { confirmToken } : {}) }));
    expect(done.statusCode).toBe(200);
    expect(done.body).not.toContain(SECRET);
    expect(await taskCount()).toBe(2);
  });

  it('确认令牌绑定参数：用过 409、换参数 409，都不会多建任务', async () => {
    const { owner, secretId, confirmed, taskCount } = await setup();
    const sid = await secretId();
    const args = { kind: 'login', site: 'https://example.com/', secrets: [{ secretId: sid, field: 'password' }] };
    let token = '';
    const done = await confirmed((t) => {
      if (t) token = t;
      return owner('POST', '/api/gateway/call', { tool: 'browser_task_create', args, ...(t ? { confirmToken: t } : {}) });
    });
    expect(done.statusCode).toBe(200);
    expect(await taskCount()).toBe(1);
    const again = await owner('POST', '/api/gateway/call', { tool: 'browser_task_create', args, confirmToken: token });
    expect(again.statusCode).toBe(409);
    const other = await owner('POST', '/api/gateway/call', { tool: 'browser_task_create', args: { ...args, site: 'https://evil.example/' }, confirmToken: token });
    expect(other.statusCode).toBe(409);
    expect(await taskCount()).toBe(1);
  });

  it('账号（非所有者）做不了重要确认：danger 调用 403', async () => {
    const { register } = await setup();
    const a = await register('a@example.com');
    const sidA = (await a('POST', '/api/vault', { name: 'x', kind: 'password', value: SECRET })).json().secret.id as string;
    const r = await a('POST', '/api/gateway/call', { tool: 'browser_task_create', args: { kind: 'login', site: 'https://example.com/', secrets: [{ secretId: sidA, field: 'password' }] } });
    expect(r.statusCode).toBe(403);
  });

  it('不存在的工具 404；未登录 401；客户端令牌 403', async () => {
    const { owner, bearer, app } = await setup();
    expect((await owner('POST', '/api/gateway/call', { tool: 'nope', args: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/gateway/tools' })).statusCode).toBe(401);
    const client = (await owner('POST', '/api/clients', { name: 'c', scopes: ['library:read'] })).json().token as string;
    expect((await bearer(client)('GET', '/api/gateway/tools')).statusCode).toBe(403);
    expect((await bearer(client)('POST', '/api/gateway/call', { tool: 'browser_task_status', args: { taskId: 'x' } })).statusCode).toBe(403);
  });

  it('登记 HTTP 工具要凭据类确认；坏登记 400；登记后工具出现且 spend 调用先 428（不发请求）', async () => {
    const { owner, confirmed, secretId } = await setup();
    const sid = await secretId();
    const def = { ...httpDef, auth: { type: 'bearer', secretId: sid } };
    expect((await owner('PUT', '/api/gateway/http-tools', { def: { ...def, baseUrl: 'http://api.example.com/v1' } })).statusCode).toBe(400);
    expect((await owner('PUT', '/api/gateway/http-tools', { def: { ...def, auth: { type: 'bearer', secretId: '00000000-0000-4000-8000-000000000000' } } })).statusCode).toBe(400);
    expect((await owner('PUT', '/api/gateway/http-tools', { def: { ...def, allowedHosts: ['other.example.com'] } })).statusCode).toBe(400);
    const first = await owner('PUT', '/api/gateway/http-tools', { def });
    expect(first.statusCode).toBe(428);
    expect(first.json().error.confirm.kind).toBe('credential');
    expect((await owner('GET', '/api/gateway/http-tools')).json().tools).toHaveLength(0);
    const put = await confirmed((confirmToken) => owner('PUT', '/api/gateway/http-tools', { def, ...(confirmToken ? { confirmToken } : {}) }));
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(SECRET);
    expect((await owner('GET', '/api/gateway/http-tools')).json().tools).toHaveLength(1);
    const tools = (await owner('GET', '/api/gateway/tools')).json().tools as { name: string; risk: string }[];
    expect(tools.find((t) => t.name === 'paid_search')?.risk).toBe('spend');
    const call = await owner('POST', '/api/gateway/call', { tool: 'paid_search', args: { path: '/q' } });
    expect(call.statusCode).toBe(428);
    expect(call.json().error.confirm.kind).toBe('payment');
    expect((await owner('DELETE', '/api/gateway/http-tools/paid_search')).statusCode).toBe(204);
    expect((await owner('POST', '/api/gateway/call', { tool: 'paid_search', args: { path: '/q' } })).statusCode).toBe(404);
  });

  it('账号之间互相看不到对方登记的工具', async () => {
    const { owner, register, confirmed, secretId } = await setup();
    const sid = await secretId();
    const def = { ...httpDef, risk: 'read', auth: { type: 'bearer', secretId: sid } };
    expect((await confirmed((confirmToken) => owner('PUT', '/api/gateway/http-tools', { def, ...(confirmToken ? { confirmToken } : {}) }))).statusCode).toBe(200);
    const b = await register('b@example.com');
    expect(((await b('GET', '/api/gateway/tools')).json().tools as { name: string }[]).map((t) => t.name)).not.toContain('paid_search');
    expect((await b('POST', '/api/gateway/call', { tool: 'paid_search', args: { path: '/q' } })).statusCode).toBe(404);
  });
});
