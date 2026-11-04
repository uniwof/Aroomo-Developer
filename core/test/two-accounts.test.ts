/** D205：小号 seed（幂等）+ 两个账号测试基建自检。 */
import { describe, expect, it } from 'vitest';
import { MemoryUserStore } from '../src/users/memory.js';
import { seedXiaohao } from '../src/users/seed.js';
import { main as seedCli } from '../src/seed/xiaohao.js';
import { fakeClock } from './helpers/db.js';
import { expectDenied, fakePw, expectEmptyList, expectHidden, expectSameAsMissing, twoAccountEnvs, twoAccounts } from './helpers/two-accounts.js';

describe('小号 seed', () => {
  it('幂等：第二次不变；被停用 / 改成管理员 / 改密码后再跑会校正，并吊销旧会话', async () => {
    const store = new MemoryUserStore();
    const clock = fakeClock();
    const input = { email: 'x@example.test', password: fakePw(1) };
    const a = await seedXiaohao(store, input, clock.now);
    expect(a.outcome).toBe('created');
    const b = await seedXiaohao(store, input, clock.now);
    expect(b).toEqual({ userId: a.userId, outcome: 'unchanged' });
    await store.updateUser(a.userId, { status: 'disabled', role: 'admin' }, clock.now());
    await store.insertSession({ tokenHash: 'h1', userId: a.userId, createdAt: clock.now(), expiresAt: new Date(clock.now().getTime() + 1e9), revokedAt: null });
    const c = await seedXiaohao(store, { ...input, password: fakePw(2) }, clock.now);
    expect(c.outcome).toBe('updated');
    const u = await store.getUser(a.userId);
    expect(u).toMatchObject({ role: 'user', status: 'active', displayName: '小号' });
    expect((await store.getSession('h1'))?.revokedAt).not.toBeNull();
    expect((await store.listUsers()).length).toBe(1);
  });

  it('拒绝坏输入，不回显密码', async () => {
    const store = new MemoryUserStore();
    await expect(seedXiaohao(store, { email: 'bad', password: fakePw(1) }, () => new Date())).rejects.toThrow('邮箱');
    await expect(seedXiaohao(store, { email: 'x@example.test', password: 'short' }, () => new Date())).rejects.toThrow(/密码长度/);
    await seedXiaohao(store, { email: 'x@example.test', password: 'short' }, () => new Date()).catch((e: Error) => expect(e.message).not.toContain('short'));
  });

  it('CLI：缺环境变量返回 2；生产环境默认拒绝返回 3（不连库）', async () => {
    expect(await seedCli({})).toBe(2);
    expect(await seedCli({ CORE_DATABASE_URL: 'postgres://x/y', XIAOHAO_EMAIL: 'x@example.test', XIAOHAO_PASSWORD: 'p', NODE_ENV: 'production' })).toBe(3);
  });
});

describe.each(twoAccountEnvs)('两个账号基建（$name）', (env) => {
  it('所有者与小号身份各自可用；小号看不到所有者的成员，改不了，也看不出存在', async () => {
    const t = await twoAccounts(env);
    try {
      expect((await t.xiao('GET', '/api/auth/me')).json().user).toMatchObject({ id: t.xiaoId, role: 'user', displayName: '小号' });
      expect((await t.owner('POST', '/api/members', { name: 'Owner Secret Bot' })).statusCode).toBe(201);
      expectEmptyList(await t.xiao('GET', '/api/members'), 'members');
      expectHidden(await t.xiao('GET', '/api/members'), ['Owner Secret Bot', 'owner-secret-bot']);
      expectDenied(await t.xiao('PATCH', '/api/members/owner-secret-bot', { name: 'x' }), ['Owner Secret Bot']);
      expectDenied(await t.xiao('DELETE', '/api/members/owner-secret-bot'), ['Owner Secret Bot']);
      await expectSameAsMissing((id) => t.xiao('PATCH', `/api/members/${id}`, { name: 'x' }), 'owner-secret-bot');
      // 小号自己的功能完整可用
      expect((await t.xiao('POST', '/api/members', { name: 'Xiao Bot' })).statusCode).toBe(201);
      expect((await t.xiao('GET', '/api/members')).json().members.map((m: { name: string }) => m.name)).toEqual(['Xiao Bot']);
      expect((await t.owner('GET', '/api/members')).json().members.map((m: { name: string }) => m.name)).toEqual(['Owner Secret Bot']);
    } finally {
      await t.close();
    }
  });
});
