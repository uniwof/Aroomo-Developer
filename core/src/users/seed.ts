/**
 * D205「两个账号」规则：固定测试账号「小号」的 seed（幂等）。
 *
 * - 邮箱、密码只从调用方传入（CLI 从环境变量读），不写进仓库、不打印、不进审计详情。
 * - 已存在：确保是启用的普通账号（role=user），密码不一致时改成传入的密码；不存在：创建。
 * - 只是一个普通账号，不给任何额外权限；所有者数据对它的隔离由各模块的 forUser / RLS 保证。
 */
import { randomUUID } from 'node:crypto';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from './password.js';
import type { UserStore } from './types.js';

export const XIAOHAO_DISPLAY_NAME = '小号';

export interface SeedXiaohaoInput {
  email: string;
  password: string;
  displayName?: string;
}

export type SeedOutcome = 'created' | 'updated' | 'unchanged';

export async function seedXiaohao(store: UserStore, input: SeedXiaohaoInput, now: () => Date): Promise<{ userId: string; outcome: SeedOutcome }> {
  const email = String(input.email ?? '').trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw new Error('小号邮箱格式不对');
  const pw = String(input.password ?? '');
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) throw new Error(`小号密码长度需在 ${PASSWORD_MIN}–${PASSWORD_MAX} 位之间`);
  const displayName = (input.displayName ?? XIAOHAO_DISPLAY_NAME).slice(0, 64);

  const existing = await store.getUserByEmail(email);
  if (!existing) {
    const at = now();
    const id = randomUUID();
    await store.insertUser({ id, email, displayName, role: 'user', status: 'active', passwordHash: await hashPassword(pw), createdAt: at, updatedAt: at });
    return { userId: id, outcome: 'created' };
  }
  const patch: { role?: 'user'; status?: 'active'; displayName?: string; passwordHash?: string } = {};
  if (existing.role !== 'user') patch.role = 'user';
  if (existing.status !== 'active') patch.status = 'active';
  if (existing.displayName !== displayName) patch.displayName = displayName;
  if (!(await verifyPassword(pw, existing.passwordHash))) patch.passwordHash = await hashPassword(pw);
  if (Object.keys(patch).length === 0) return { userId: existing.id, outcome: 'unchanged' };
  const at = now();
  await store.updateUser(existing.id, patch, at);
  if (patch.passwordHash || patch.role) await store.revokeUserSessions(existing.id, at);
  return { userId: existing.id, outcome: 'updated' };
}
