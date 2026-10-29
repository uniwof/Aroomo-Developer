/**
 * 越权测试（D117-18）：用户 A 用任何接口都拿不到用户 B 的数据；CI 必跑。
 * 随 B1b 逐模块扩充：每个模块放开 userRoute 的同时，在这里加它的越权用例。
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { recycleBinJob } from '../src/jobs/jobs.js';
import { MembersService } from '../src/members/service.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await t.open(), now) })),
];

describe.each(envs)('越权测试：成员（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
    apps.push(app);
    const call = (headers: Record<string, string>) => (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const register = async (email: string) => {
      const inv = await owner('POST', '/api/users/invites', { email });
      const r = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
      return call({ authorization: `Bearer ${r.json().token}` });
    };
    return { app, deps, clock, owner, register };
  }

  it('A、B、所有者各有各的成员：互相看不见，同名同 id 也不冲突', async () => {
    const { owner, register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    expect((await a('POST', '/api/members', { name: 'Groq' })).statusCode).toBe(201);
    expect((await b('POST', '/api/members', { name: 'Groq' })).statusCode).toBe(201); // 同名不冲突
    expect((await owner('POST', '/api/members', { name: 'Groq' })).statusCode).toBe(201);
    expect((await a('POST', '/api/members', { name: 'Only A' })).statusCode).toBe(201);
    const names = async (c: typeof a) => (await c('GET', '/api/members')).json().members.map((m: { name: string }) => m.name).sort();
    expect(await names(a)).toEqual(['Groq', 'Only A']);
    expect(await names(b)).toEqual(['Groq']);
    expect(await names(owner)).toEqual(['Groq']);
  });

  it('B 对 A 的成员做任何操作都像「不存在」：改、删、恢复、置顶、重排', async () => {
    const { register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    await a('POST', '/api/members', { name: 'Secret Helper' });
    const id = 'secret-helper';
    expect((await b('PATCH', `/api/members/${id}`, { name: 'Hacked' })).statusCode).toBe(404);
    expect((await b('DELETE', `/api/members/${id}`)).statusCode).toBe(404);
    expect((await b('POST', `/api/members/${id}/restore`)).statusCode).toBe(404);
    expect((await b('PUT', `/api/members/${id}/pin`)).statusCode).toBe(404);
    expect((await b('PUT', '/api/members/order', { ids: [id] })).statusCode).toBe(400); // 集合与 B 自己的不一致
    // A 的数据没被动过
    const mine = (await a('GET', '/api/members')).json().members;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Secret Helper', pinned: false });
    expect((await b('GET', '/api/members?deleted=true')).json().members).toEqual([]);
  });

  it('A 的回收站、重排只影响 A', async () => {
    const { register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    await a('POST', '/api/members', { name: 'A1' });
    await a('POST', '/api/members', { name: 'A2' });
    await b('POST', '/api/members', { name: 'B1' });
    await a('DELETE', '/api/members/a1');
    expect((await a('GET', '/api/members?deleted=true')).json().members).toHaveLength(1);
    expect((await b('GET', '/api/members?deleted=true')).json().members).toHaveLength(0);
    expect((await b('GET', '/api/members')).json().members).toHaveLength(1);
    const re = await a('PUT', '/api/members/order', { ids: ['a2'] });
    expect(re.statusCode).toBe(200);
    expect((await b('GET', '/api/members')).json().members.map((m: { id: string }) => m.id)).toEqual(['b1']);
  });

  it('账号不能彻底删除、不能走候选入职流程（仍是所有者全局的）', async () => {
    const { register } = await setup();
    const a = await register('a@example.com');
    await a('POST', '/api/members', { name: 'X' });
    await a('DELETE', '/api/members/x');
    expect((await a('POST', '/api/members/x/purge')).statusCode).toBe(403);
    expect((await a('POST', '/api/members/x/onboard')).statusCode).toBe(403);
  });

  it('负责人设置按用户隔离：A 选的负责人不影响 B / 所有者，B 选不了 A 的成员', async () => {
    const { deps, owner, register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const uid = async (c: typeof a) => (await c('GET', '/api/auth/me')).json().user.id as string;
    const caps = { mode: 'chat', maxInputTokens: 128000, supportsTools: true, checkedAt: new Date().toISOString() };
    for (const [c, name] of [[a, 'Alpha'], [b, 'Beta']] as const) {
      await c('POST', '/api/members', { name });
      const store = deps.members.forUser(await uid(c));
      const m = (await store.listAll())[0]!;
      await store.update({ ...m, modelCaps: caps });
    }
    expect((await a('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('alpha');
    expect((await b('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('beta');
    expect((await owner('GET', '/api/settings/lead')).json().effectiveLeadId).toBeNull();
    expect((await a('PUT', '/api/settings/lead', { leadId: 'alpha' })).json()).toMatchObject({ leadId: 'alpha', auto: false });
    expect((await b('GET', '/api/settings/lead')).json().leadId).toBeNull();
    expect((await owner('GET', '/api/settings/lead')).json().leadId).toBeNull();
    expect((await b('PUT', '/api/settings/lead', { leadId: 'alpha' })).statusCode).toBe(400); // B 没有 alpha
    // 敏感内容保护开关仍是所有者专属
    expect((await a('GET', '/api/settings/security')).statusCode).toBe(403);
    expect((await a('PUT', '/api/settings/security', { sensitiveProtect: false })).statusCode).toBe(403);
  });

  it('回收站清理任务逐个用户处理，且只清各自的', async () => {
    const { app, deps, clock, register } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    await a('POST', '/api/members', { name: 'Old A' });
    await b('POST', '/api/members', { name: 'Old B' });
    await a('DELETE', '/api/members/old-a');
    await b('DELETE', '/api/members/old-b');
    clock.advance(31 * 24 * 3600_000);
    await app.jobs.runOnce('recycle-bin');
    for (const u of await deps.members.userIds()) {
      expect(await deps.members.forUser(u).listAll()).toEqual([]);
    }
    // 单独调用 recycleBinJob 也能处理多个用户（接口形状）
    const job = recycleBinJob(async () => (await deps.members.userIds()).map((u) => new MembersService(deps.members.forUser(u), deps.now)));
    expect(job.name).toBe('recycle-bin');
  });

  it('存储层：forUser 视图互相隔离（get / delete / reorder / userIds）', async () => {
    const { deps } = await setup();
    const now = new Date();
    const mk = (id: string) => ({
      id, name: id, aliases: [], capabilityTags: [], enabled: true, pinned: false, sortOrder: 0,
      status: 'active' as const, modelCaps: null, deletedAt: null, createdAt: now, updatedAt: now,
    });
    const u1 = deps.members.forUser('u1');
    const u2 = deps.members.forUser('u2');
    await u1.insert(mk('same'));
    await u2.insert(mk('same'));
    expect(await u1.get('same')).not.toBeNull();
    expect(await deps.members.get('same')).toBeNull(); // 所有者视图看不到
    expect(await u2.delete('same')).toBe(true);
    expect(await u2.get('same')).toBeNull();
    expect(await u1.get('same')).not.toBeNull(); // u1 的没被 u2 的删除影响
    await u1.reorder(['same'], now);
    expect(await deps.members.userIds()).toEqual(['u1']);
  });
});
