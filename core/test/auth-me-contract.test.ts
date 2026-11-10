/**
 * #377 / #293 负责人第 1 轮 M4：GET /api/auth/me 的响应形状写死。
 * Shell 把这条按 Cookie 直通给浏览器（D256 白名单），所以 key 集合必须精确等于约定、不含任何令牌 / 哈希；
 * 以后谁加字段，这条会失败，必须走 A+ 审查（同时更新 Shell 白名单文档）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/users/password.js';
import { OWNER_TOKEN, fakeClock } from './helpers/db.js';
import { fakePw } from './helpers/two-accounts.js';

const OWNER_ID = '4e000000-0000-4000-8000-00000000a377';
const FAMILY_ID = '4e000000-0000-4000-8000-00000000f377';
const OWNER_PW = fakePw(37);
const FAMILY_PW = fakePw(38);

/** 约定的形状：只这些 key，不多不少 */
const TOP_KEYS = ['kind', 'ownerAccount', 'user'];
const USER_KEYS = ['createdAt', 'displayName', 'email', 'id', 'role', 'status'];

describe('#377 M4 GET /api/auth/me 契约（Cookie 会话，Shell 直通的就是这条）', () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function start() {
    const clock = fakeClock();
    const deps = memoryDeps(clock.now);
    const at = clock.now();
    await deps.users.insertUser({ id: OWNER_ID, email: 'owner377@example.test', displayName: '宝宝', role: 'admin', status: 'active', passwordHash: await hashPassword(OWNER_PW), createdAt: at, updatedAt: at });
    await deps.users.insertUser({ id: FAMILY_ID, email: 'family377@example.test', displayName: '家人', role: 'user', status: 'active', passwordHash: await hashPassword(FAMILY_PW), createdAt: at, updatedAt: at });
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', CORE_OWNER_ACCOUNT_ID: OWNER_ID }), deps);
    apps.push(app);
    const cookieOf = async (email: string, password: string) => {
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, cookie: true } });
      expect(r.statusCode, r.body).toBe(200);
      return String(r.headers['set-cookie']).split(';')[0]!;
    };
    return { app, cookieOf };
  }

  it('所有者账号与家人：key 集合精确等于约定；ownerAccount 只有所有者为 true；没有令牌 / 哈希 / 密码', async () => {
    const { app, cookieOf } = await start();
    for (const [email, pw, id, owner] of [
      ['owner377@example.test', OWNER_PW, OWNER_ID, true],
      ['family377@example.test', FAMILY_PW, FAMILY_ID, false],
    ] as const) {
      const cookie = await cookieOf(email, pw);
      const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(r.statusCode).toBe(200);
      const body = r.json() as Record<string, unknown> & { user: Record<string, unknown> };
      expect(Object.keys(body).sort()).toEqual(TOP_KEYS);
      expect(Object.keys(body.user).sort()).toEqual(USER_KEYS);
      expect(body.kind).toBe('user');
      expect(body.ownerAccount).toBe(owner);
      expect(body.user.id).toBe(id);
      expect(r.body).not.toMatch(/token|hash|secret|password|csrf/i);
      expect(r.body).not.toContain(pw);
      expect(r.body).not.toContain(cookie.split('=')[1]!);
    }
  });
});
