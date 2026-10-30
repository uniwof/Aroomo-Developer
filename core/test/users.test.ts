import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';

interface Env {
  name: string;
  make: (now: () => Date) => Promise<CoreDeps>;
}
const envs: Env[] = [
  { name: 'memory', make: async (now) => memoryDeps(now) },
  ...dbTargets.map<Env>((t) => ({ name: t.name, make: async (now) => pgDeps(await t.open(), now) })),
];

describe.each(envs)('账号与登录 B1（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
    apps.push(app);
    const owner = (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({ method, url, headers: ownerAuth, ...(payload ? { payload } : {}) });
    const as = (token: string) => (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
    /** 管理员发邀请 → 受邀者注册，返回会话令牌与用户 id */
    const register = async (email: string, role: 'admin' | 'user' = 'user', password = PW) => {
      const inv = await owner('POST', '/api/users/invites', { email, role });
      expect(inv.statusCode).toBe(201);
      const r = await post('/auth/accept', { token: inv.json().token, password, displayName: email.split('@')[0] });
      expect(r.statusCode).toBe(200);
      return { token: r.json().token as string, id: r.json().user.id as string, invite: inv.json().token as string };
    };
    return { app, deps, clock, owner, as, post, register };
  }

  it('邀请 → 注册 → 登录 → me；邀请只能用一次', async () => {
    const { post, register, as } = await setup();
    const a = await register('alice@example.com');
    const me = await as(a.token)('GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'alice@example.com', role: 'user', status: 'active' });
    expect(JSON.stringify(me.json())).not.toMatch(/scrypt|passwordHash/);
    const again = await post('/auth/accept', { token: a.invite, password: PW });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('INVITE_INVALID');
    const login = await post('/auth/login', { email: 'ALICE@example.com', password: PW });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toMatch(/^ars_/);
  });

  it('邀请过期不能用；弱密码、坏邮箱、重复邮箱被拒', async () => {
    const { owner, post, clock, register } = await setup();
    const inv = await owner('POST', '/api/users/invites', { email: 'bob@example.com' });
    expect((await post('/auth/accept', { token: inv.json().token, password: 'short' })).json().error.code).toBe('WEAK_PASSWORD');
    clock.advance(8 * 24 * 3600_000);
    expect((await post('/auth/accept', { token: inv.json().token, password: PW })).statusCode).toBe(400);
    expect((await owner('POST', '/api/users/invites', { email: 'not-an-email' })).statusCode).toBe(400);
    await register('carol@example.com');
    expect((await owner('POST', '/api/users/invites', { email: 'Carol@Example.com' })).json().error.code).toBe('EMAIL_TAKEN');
  });

  it('密码错误 401；连续 5 次错误后锁 15 分钟（正确密码也不行），到期恢复', async () => {
    const { post, clock, register } = await setup();
    await register('dave@example.com');
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/login', { email: 'dave@example.com', password: 'wrong-password-1' });
      expect(r.statusCode).toBe(401);
    }
    expect((await post('/auth/login', { email: 'dave@example.com', password: PW })).statusCode).toBe(429);
    clock.advance(16 * 60_000);
    expect((await post('/auth/login', { email: 'dave@example.com', password: PW })).statusCode).toBe(200);
    // 不存在的邮箱和错误密码返回同样的错误，不泄露账号是否存在
    const ghost = await post('/auth/login', { email: 'nobody@example.com', password: PW });
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json().error.code).toBe('BAD_CREDENTIALS');
  });

  it('账号默认不能访问未做隔离的业务接口（Key / 审计 / 收件箱 / 设置），拒绝会写审计', async () => {
    const { owner, as, register } = await setup();
    const u = await register('erin@example.com');
    const call = as(u.token);
    for (const url of ['/api/keys', '/api/inbox', '/api/audit', '/api/settings/security']) {
      const r = await call('GET', url);
      expect(r.statusCode, url).toBe(403);
    }
    const audit = (await owner('GET', '/api/audit?action=auth.denied')).json();
    expect(audit.entries.some((e: { actor: { type: string; id: string } }) => e.actor.type === 'user' && e.actor.id === u.id)).toBe(true);
    // 管理接口也不行
    expect((await call('GET', '/api/users')).statusCode).toBe(403);
    expect((await call('POST', '/api/users/invites', { email: 'x@example.com' })).statusCode).toBe(403);
  });

  it('管理员账号可以邀请和停用别人；停用后会话立刻失效；不能停用自己或最后一个管理员', async () => {
    const { owner, as, post, register } = await setup();
    const admin = await register('admin@example.com', 'admin');
    const u = await register('frank@example.com');
    const adminCall = as(admin.token);
    expect((await adminCall('POST', '/api/users/invites', { email: 'gina@example.com' })).statusCode).toBe(201);
    expect((await adminCall('GET', '/api/users')).json().users).toHaveLength(2);
    expect((await adminCall('POST', `/api/users/${admin.id}/disable`)).statusCode).toBe(409); // 自己
    expect((await adminCall('POST', `/api/users/${u.id}/disable`)).statusCode).toBe(200);
    expect((await as(u.token)('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await post('/auth/login', { email: 'frank@example.com', password: PW })).statusCode).toBe(401);
    expect((await owner('POST', `/api/users/${u.id}/enable`)).statusCode).toBe(200);
    expect((await post('/auth/login', { email: 'frank@example.com', password: PW })).statusCode).toBe(200);
    // 所有者令牌想停用最后一个管理员 → 拒绝
    expect((await owner('POST', `/api/users/${admin.id}/disable`)).json().error.code).toBe('LAST_ADMIN');
  });

  it('退出本设备 / 退出所有设备 / 改密码后其它设备退出、本设备保留', async () => {
    const { as, post, register } = await setup();
    const u = await register('hana@example.com');
    const second = (await post('/auth/login', { email: 'hana@example.com', password: PW })).json().token as string;
    const third = (await post('/auth/login', { email: 'hana@example.com', password: PW })).json().token as string;
    expect((await as(third)('POST', '/api/auth/logout')).statusCode).toBe(204);
    expect((await as(third)('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await as(second)('GET', '/api/auth/me')).statusCode).toBe(200);

    const bad = await as(second)('POST', '/api/auth/password', { currentPassword: 'nope-nope-nope', newPassword: 'a-brand-new-password' });
    expect(bad.statusCode).toBe(403);
    const ok = await as(second)('POST', '/api/auth/password', { currentPassword: PW, newPassword: 'a-brand-new-password' });
    expect(ok.statusCode).toBe(204);
    expect((await as(u.token)('GET', '/api/auth/me')).statusCode).toBe(401); // 其它设备退出
    expect((await as(second)('GET', '/api/auth/me')).statusCode).toBe(200); // 本设备保留
    expect((await post('/auth/login', { email: 'hana@example.com', password: PW })).statusCode).toBe(401);
    const fresh = (await post('/auth/login', { email: 'hana@example.com', password: 'a-brand-new-password' })).json().token as string;

    expect((await as(fresh)('POST', '/api/auth/logout-all')).statusCode).toBe(204);
    expect((await as(second)('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await as(fresh)('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('忘记密码：管理员发重置链接 → 设新密码；旧会话与旧密码作废；链接一次性', async () => {
    const { owner, as, post, register } = await setup();
    const u = await register('ivy@example.com');
    const link = await owner('POST', `/api/users/${u.id}/reset-link`);
    expect(link.statusCode).toBe(201);
    const done = await post('/auth/accept', { token: link.json().token, password: 'totally-new-password' });
    expect(done.statusCode).toBe(200);
    expect(done.json().user.id).toBe(u.id);
    expect((await as(u.token)('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await post('/auth/login', { email: 'ivy@example.com', password: PW })).statusCode).toBe(401);
    expect((await post('/auth/login', { email: 'ivy@example.com', password: 'totally-new-password' })).statusCode).toBe(200);
    expect((await post('/auth/accept', { token: link.json().token, password: 'another-password-1' })).statusCode).toBe(400);
  });

  it('审计里没有明文密码、邀请令牌和会话令牌', async () => {
    const { owner, register } = await setup();
    const u = await register('jack@example.com');
    const text = JSON.stringify((await owner('GET', '/api/audit?limit=200')).json());
    expect(text).not.toContain(PW);
    expect(text).not.toContain(u.token);
    expect(text).not.toContain(u.invite);
    expect(text).toContain('users.register');
  });

  it('所有者令牌继续可用，且不受账号体系影响', async () => {
    const { owner } = await setup();
    expect((await owner('GET', '/api/members')).statusCode).toBe(200);
    expect((await owner('GET', '/api/auth/me')).json()).toEqual({ kind: 'owner', id: 'owner' });
  });
});
