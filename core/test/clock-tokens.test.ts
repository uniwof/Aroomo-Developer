/**
 * 假时钟 4：令牌过期（工单 #230，D67）。
 * 账号会话 30 天、客户端令牌按自己的到期天数、邀请 7 天、操作员令牌按 expiresAt；
 * 过期后一律 401，且不影响另一个账号（所有者令牌永不过期）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryOperatorTokenStore, createTokenVerifier, hmacToken } from '../src/auth/tokens.js';
import { clockApp, type ClockApp } from './helpers/clock-app.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

const SEC = 1000;
const HOUR = 3600 * SEC;
const DAY = 24 * HOUR;

describe('操作员令牌 expiresAt（单元）', () => {
  const secret = 'placeholder-token-secret-0123456789abcdef';
  const token = ['placeholder', 'operator', 'token'].join('-');
  const build = (now: () => Date, expiresAt: Date | null) => {
    const store = new MemoryOperatorTokenStore();
    store.add({ id: 'op1', hmac: hmacToken(secret, token), capabilities: [], revokedAt: null, expiresAt });
    return createTokenVerifier({ ownerToken: undefined, tokenSecret: secret, operatorTokens: store, now });
  };
  it('到期前一秒有效，到期那一刻失效', async () => {
    let t = new Date('2026-10-27T10:00:00+08:00').getTime();
    const verify = build(() => new Date(t), new Date('2026-10-28T10:00:00+08:00'));
    t = new Date('2026-10-28T09:59:59+08:00').getTime();
    expect(await verify(token)).toMatchObject({ type: 'operator', id: 'op1' });
    t = new Date('2026-10-28T10:00:00+08:00').getTime();
    expect(await verify(token)).toBeNull();
  });
});

describe.each(twoAccountEnvs)('令牌过期（$name）', (env) => {
  const open: ClockApp[] = [];
  afterEach(async () => {
    for (const t of open.splice(0)) await t.app.close();
  });
  const setup = async () => {
    const t = await clockApp(env, { start: '2026-10-27T10:00:00+08:00' });
    open.push(t);
    return t;
  };

  it('账号会话：第 29 天 23 小时还能用，满 30 天 401；重新登录就好；所有者令牌不受影响', async () => {
    const t = await setup();
    expect((await t.xiao('GET', '/api/auth/me')).statusCode).toBe(200);
    t.clock.advance(30 * DAY - HOUR);
    expect((await t.xiao('GET', '/api/auth/me')).statusCode).toBe(200);
    t.clock.advance(HOUR); // 恰好满 30 天
    expect((await t.xiao('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await t.owner('GET', '/api/members')).statusCode).toBe(200); // 所有者不受影响
    const fresh = await t.loginXiao(); // 重新登录拿到新会话
    expect((await t.bearer(fresh)('GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('跨账号：小号的会话过期，不会让另一个已登录的账号掉线；过期的令牌也不能被借给别人用', async () => {
    const t = await setup();
    const early = (await t.loginXiao()); // 第 0 天
    t.clock.advance(20 * DAY);
    const late = await t.loginXiao(); // 第 20 天再登录一次（第二个会话）
    t.clock.advance(10 * DAY + SEC); // 第 30 天零 1 秒：第一批会话过期，第 20 天那个还有 20 天
    expect((await t.bearer(early)('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await t.xiao('GET', '/api/auth/me')).statusCode).toBe(401); // 开局那个会话
    expect((await t.bearer(late)('GET', '/api/auth/me')).statusCode).toBe(200);
    // 过期令牌带不了所有者的权限
    expect((await t.bearer(early)('GET', '/api/users')).statusCode).toBe(401);
  });

  it('客户端令牌：到期前一秒有效，到期后 401；所有者和小号各自的令牌互不影响', async () => {
    const t = await setup();
    const a = await t.owner('POST', '/api/clients', { name: '所有者脚本', scopes: ['memory:read'], expiresInDays: 1 });
    expect(a.statusCode).toBe(201);
    const aTok = a.json().token as string;
    const b = await t.xiao('POST', '/api/clients', { name: '小号脚本', scopes: ['memory:read'], expiresInDays: 3 });
    expect(b.statusCode).toBe(201);
    const bTok = b.json().token as string;
    const self = (tok: string) => t.bearer(tok)('GET', '/api/clients/self');

    t.clock.advance(DAY - SEC);
    expect((await self(aTok)).statusCode).toBe(200);
    expect((await self(bTok)).statusCode).toBe(200);
    t.clock.advance(SEC); // 满 1 天
    expect((await self(aTok)).statusCode).toBe(401);
    expect((await self(bTok)).statusCode).toBe(200); // 小号的还在有效期
    t.clock.advance(2 * DAY);
    expect((await self(bTok)).statusCode).toBe(401);
    // 过期令牌不能管理令牌：也不能用来冒充
    expect((await t.bearer(aTok)('GET', '/api/clients')).statusCode).toBe(401);
    expect((await t.owner('GET', '/api/clients')).statusCode).toBe(200);
  });

  it('邀请链接 7 天过期：过期后接受被拒，账号没有被创建', async () => {
    const t = await setup();
    const inv = await t.owner('POST', '/api/users/invites', { email: 'late@example.test' });
    expect(inv.statusCode).toBeLessThan(300);
    t.clock.advance(7 * DAY + SEC);
    const r = await t.app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: 'correct-horse-battery' } });
    expect([400, 401, 403, 404, 409, 410]).toContain(r.statusCode);
    const login = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'late@example.test', password: 'correct-horse-battery' } });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
    expect(login.statusCode).toBeLessThan(500);
  });
});
