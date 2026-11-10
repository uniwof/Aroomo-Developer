/**
 * #345 P2 负责人第 1 轮 M5：users_self 允许本人改自己那行的 role / status，数据库分不出「本人提权」和「管理员停用别人」，
 * 这道防线在应用层。这里用 HTTP 证明：家人（普通账号）从任何自助接口提交 role / status，库里 role / status 都不变。
 * updateUser 的全部调用点：users/service.ts 的 acceptInvite（重置密码，只改 passwordHash）、changePassword（只改 passwordHash）、
 * setStatus（只给 adminGuard 的 /api/users/:id/enable|disable）；users/seed.ts 的 seedXiaohao（启动时把小号拉回 user / active）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { XIAOHAO_TEST_PASSWORD, fakePw, twoAccountEnvs, twoAccounts } from './helpers/two-accounts.js';

describe.each(twoAccountEnvs)('M5 家人从自助接口提交 role / status，库里不变（$name）', (env) => {
  it('改密 / 接受邀请夹带 role、status → 400；管理员接口 → 403；正常改密后 role、status 仍不变', async () => {
    const t = await twoAccounts(env);
    try {
      const snap = async () => (await t.deps.users.listUsers()).map((u) => ({ id: u.id, role: u.role, status: u.status }));
      const before = await snap();
      expect(before.find((u) => u.id === t.xiaoId)).toEqual({ id: t.xiaoId, role: 'user', status: 'active' });

      const pw = { currentPassword: XIAOHAO_TEST_PASSWORD, newPassword: fakePw(2) };
      expect((await t.xiao('POST', '/api/auth/password', { ...pw, role: 'admin' })).statusCode).toBe(400);
      expect((await t.xiao('POST', '/api/auth/password', { ...pw, status: 'disabled' })).statusCode).toBe(400);
      const acc = await t.app.inject({ method: 'POST', url: '/auth/accept', payload: { token: 'x'.repeat(43), password: fakePw(3), role: 'admin', status: 'active' } });
      expect(acc.statusCode).toBe(400);
      for (const url of [`/api/users/${t.xiaoId}/enable`, `/api/users/${t.xiaoId}/disable`]) expect((await t.xiao('POST', url)).statusCode, url).toBe(403);
      expect((await t.xiao('POST', '/api/users/invites', { email: 'evil@example.test', role: 'admin' })).statusCode).toBe(403);
      expect(await snap()).toEqual(before);

      // 正向对照：同一接口不夹带时成功，role / status 仍不变
      expect((await t.xiao('POST', '/api/auth/password', pw)).statusCode).toBe(204);
      expect(await snap()).toEqual(before);
    } finally {
      await t.close();
    }
  });
});

/**
 * 负责人第 2 轮 C1：上面那条 /auth/accept 用的是无效令牌，400 证明不了夹带被拒（可能是假阴性）。
 * 这里用真实签发的 role=user 邀请和真实重置链接各夹带一次 role:'admin' / status，
 * 断言 400 来自 schema 校验（BAD_REQUEST，不是 INVITE_INVALID）、邀请 / 重置令牌仍未用（used_at 仍为 NULL）、users 快照不变；
 * 正向对照：不夹带时注册成功、新账号 role=user，重置成功、role / status 不变。
 * 回退自检：把 /auth/accept 的 additionalProperties 临时放开，这条用例必须 FAIL（已手动验证，不提交回退）。
 */
describe.each(twoAccountEnvs)('C1 真实邀请 / 重置链接夹带 role、status → schema 拒绝，邀请未用、账号不变（$name）', (env) => {
  it('邀请注册与重置密码各夹带一次：400 BAD_REQUEST；used_at 仍为 NULL；users 不变；不夹带时成功且 role=user', async () => {
    const t = await twoAccounts(env);
    try {
      const sha = (x: string) => createHash('sha256').update(x).digest('hex');
      const snap = async () =>
        (await t.deps.users.listUsers()).map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, passwordHash: u.passwordHash }));
      const stillOpen = async (token: string) => (await t.deps.users.listOpenInvites(t.clock.now())).some((i) => i.tokenHash === sha(token) && i.usedAt === null);
      const smuggles = [{ role: 'admin' }, { status: 'active' }, { role: 'admin', status: 'active' }];
      const expectSchema400 = (res: Awaited<ReturnType<typeof t.app.inject>>) => {
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error).toMatchObject({ code: 'BAD_REQUEST', message: '请求参数不合法' });
      };

      // 真实签发：所有者建一张 role=user 邀请，给小号发一条重置链接
      const inv = await t.owner('POST', '/api/users/invites', { email: 'newbie@example.test', role: 'user' });
      expect(inv.statusCode, inv.body).toBe(201);
      const invToken = inv.json().token as string;
      expect(inv.json().role).toBe('user');
      const rst = await t.owner('POST', `/api/users/${t.xiaoId}/reset-link`);
      expect(rst.statusCode, rst.body).toBe(201);
      const rstToken = rst.json().token as string;
      expect(await stillOpen(invToken)).toBe(true);
      expect(await stillOpen(rstToken)).toBe(true);

      const before = await snap();
      for (const extra of smuggles) {
        for (const token of [invToken, rstToken]) {
          expectSchema400(await t.app.inject({ method: 'POST', url: '/auth/accept', payload: { token, password: fakePw(5), ...extra } }));
        }
      }
      expect(await stillOpen(invToken), '夹带请求不应用掉邀请').toBe(true);
      expect(await stillOpen(rstToken), '夹带请求不应用掉重置链接').toBe(true);
      expect(await snap(), '夹带请求后 users 必须不变').toEqual(before);

      // 正向对照：不夹带 → 邀请注册成功，新账号 role=user、active；邀请被用掉
      const ok = await t.app.inject({ method: 'POST', url: '/auth/accept', payload: { token: invToken, password: fakePw(6) } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().user).toMatchObject({ email: 'newbie@example.test', role: 'user', status: 'active' });
      expect(await stillOpen(invToken)).toBe(false);
      const created = (await t.deps.users.getUserByEmail('newbie@example.test'))!;
      expect({ role: created.role, status: created.status }).toEqual({ role: 'user', status: 'active' });

      // 正向对照：不夹带 → 重置成功，小号 role / status 不变，只换了密码
      const ok2 = await t.app.inject({ method: 'POST', url: '/auth/accept', payload: { token: rstToken, password: fakePw(7) } });
      expect(ok2.statusCode, ok2.body).toBe(200);
      const xiao = (await t.deps.users.getUser(t.xiaoId))!;
      expect({ role: xiao.role, status: xiao.status }).toEqual({ role: 'user', status: 'active' });
      expect(xiao.passwordHash).not.toBe(before.find((u) => u.id === t.xiaoId)!.passwordHash);
      expect(await stillOpen(rstToken)).toBe(false);
    } finally {
      await t.close();
    }
  });
});

describe('getUser 行为写死（内存存储；PG 见 rls-p2.test.ts）', () => {
  it("id 存在 → 那一行；不存在 → null；'owner' → null", async () => {
    const t = await twoAccounts(twoAccountEnvs[0]!);
    try {
      expect(await t.deps.users.getUser(t.xiaoId)).toMatchObject({ id: t.xiaoId, role: 'user', status: 'active' });
      expect(await t.deps.users.getUser('00000000-0000-4000-8000-0000000000ee')).toBeNull();
      expect(await t.deps.users.getUser('owner')).toBeNull();
    } finally {
      await t.close();
    }
  });
});
