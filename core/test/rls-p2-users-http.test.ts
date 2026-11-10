/**
 * #345 P2 负责人第 1 轮 M5：users_self 允许本人改自己那行的 role / status，数据库分不出「本人提权」和「管理员停用别人」，
 * 这道防线在应用层。这里用 HTTP 证明：家人（普通账号）从任何自助接口提交 role / status，库里 role / status 都不变。
 * updateUser 的全部调用点：users/service.ts 的 acceptInvite（重置密码，只改 passwordHash）、changePassword（只改 passwordHash）、
 * setStatus（只给 adminGuard 的 /api/users/:id/enable|disable）；users/seed.ts 的 seedXiaohao（启动时把小号拉回 user / active）。
 */
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
