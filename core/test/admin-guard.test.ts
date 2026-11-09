/**
 * #349：adminGuard 的管理员检查挂在 preValidation（请求体 / 参数校验之前），未授权请求先拿 401/403，不先拿 schema 400。
 * 越权反向：无令牌、家人（普通账号）令牌、错误角色（操作员令牌、家人的客户端令牌）。正向：管理员照样走校验（坏请求体 400）。
 * 结构：所有挂 adminGuard 的路由，管理员检查都在 preValidation，不在 preHandler（防止以后再挂回校验之后）。
 * 测试里全是占位凭据，和任何真实账号、真实密钥无关。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { adminGuard, requireAdmin } from '../src/auth/plugin.js';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { seedXiaohao } from '../src/users/seed.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';
import { fakePw } from './helpers/two-accounts.js';
import { seenRoutes } from './authz/route-registry.js';

vi.mock('fastify', async (orig) => (await import('./authz/route-registry.js')).wrapFastify(await orig<typeof import('fastify')>()));

const OP = 'placeholder-operator-token-admin-349';
const MISSING_UUID = '00000000-0000-4000-8000-000000000349';

let app: FastifyInstance;
let deps: CoreDeps;
const headers: Record<'family' | 'familyClient' | 'operator' | 'admin', Record<string, string>> = {} as never;

beforeAll(async () => {
  const clock = fakeClock();
  deps = memoryDeps(clock.now);
  (deps.operatorTokens as MemoryOperatorTokenStore).add({
    id: 'op349',
    hmac: hmacToken(TOKEN_SECRET, OP),
    // 操作员令牌即使写了很多能力，也不是管理员
    capabilities: ['members:read', 'inbox:read', 'settings:write'],
    revokedAt: null,
    expiresAt: null,
  });
  app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_ACCESS_REAUTH: 'off' }), deps);
  await app.ready();

  const famPw = fakePw(349);
  await seedXiaohao(deps.users, { email: 'family-349@example.test', password: famPw }, clock.now);
  const login = async (email: string, password: string) => {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    expect(r.statusCode).toBe(200);
    return { authorization: `Bearer ${r.json().token as string}` };
  };
  headers.family = await login('family-349@example.test', famPw);
  const c = await app.inject({ method: 'POST', url: '/api/clients', headers: headers.family, payload: { name: 'fam', scopes: ['memory:read'] } });
  expect(c.statusCode).toBe(201);
  headers.familyClient = { authorization: `Bearer ${c.json().token as string}` };
  headers.operator = { authorization: `Bearer ${OP}` };
  // 管理员账号：所有者发 admin 邀请 → 接受
  const inv = await app.inject({ method: 'POST', url: '/api/users/invites', headers: ownerAuth, payload: { email: 'admin-349@example.test', role: 'admin' } });
  expect(inv.statusCode).toBe(201);
  const adminPw = fakePw(3490);
  const acc = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: adminPw, displayName: 'admin349' } });
  expect(acc.statusCode).toBe(200);
  headers.admin = { authorization: `Bearer ${acc.json().token as string}` };
});
afterAll(async () => {
  await app.close();
});

/** 每条 adminGuard 路由的「坏请求」：body 多字段 / 缺字段，或 params 不是 uuid —— 管理员拿 400，其他人必须先拿 401/403 */
const BAD: Record<string, InjectOptions> = {
  'GET /api/users': { method: 'GET', url: '/api/users' },
  'POST /api/users/invites': { method: 'POST', url: '/api/users/invites', payload: { role: 'root', extra: 1 } },
  'POST /api/users/:id/disable': { method: 'POST', url: '/api/users/not-a-uuid/disable' },
  'POST /api/users/:id/enable': { method: 'POST', url: '/api/users/not-a-uuid/enable' },
  'POST /api/users/:id/reset-link': { method: 'POST', url: '/api/users/not-a-uuid/reset-link' },
};
const adminRoutes = () =>
  [...new Map(seenRoutes.map((r) => [`${r.method} ${r.url}`, r])).entries()]
    .map(([key, r]) => ({ key, preValidation: r.preValidation, preHandler: r.preHandler }))
    .filter((r) => r.preValidation.includes(requireAdmin) || r.preHandler.includes(requireAdmin));

describe('#349 adminGuard 在请求体校验之前', () => {
  it('结构：adminGuard() 只给 preValidation，不给 preHandler', () => {
    const g = adminGuard() as Record<string, unknown>;
    expect(g.preValidation).toBe(requireAdmin);
    expect(g.preHandler).toBeUndefined();
  });

  it('结构：所有挂管理员检查的路由都在 preValidation，没有一条在 preHandler', () => {
    const found = adminRoutes();
    expect(found.map((r) => r.key).sort(), '新增 adminGuard 路由要在 BAD 里补坏请求').toEqual(Object.keys(BAD).sort());
    expect(found.filter((r) => r.preHandler.includes(requireAdmin)).map((r) => r.key)).toEqual([]);
    expect(found.filter((r) => !r.preValidation.includes(requireAdmin)).map((r) => r.key)).toEqual([]);
  });

  it('复现：家人令牌 + 非法请求体 → 403（修前是 400 校验错误）', async () => {
    const r = await app.inject({ ...BAD['POST /api/users/invites']!, headers: headers.family });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
    expect(r.body).not.toMatch(/body|must have|additional|required/i);
  });

  it('越权反向：每条 adminGuard 路由，无令牌 401；家人、家人客户端令牌、操作员 403；均不先 400', async () => {
    const wrong: string[] = [];
    for (const r of adminRoutes()) {
      const bad = BAD[r.key]!;
      const none = await app.inject(bad);
      if (none.statusCode !== 401) wrong.push(`${r.key} 无令牌 → ${none.statusCode}`);
      for (const who of ['family', 'familyClient', 'operator'] as const) {
        const res = await app.inject({ ...bad, headers: headers[who] });
        if (res.statusCode !== 403 || res.json().error.code !== 'FORBIDDEN') wrong.push(`${r.key} ${who} → ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('家人被拒写审计 auth.denied（role=admin）', async () => {
    const before = (await deps.auditLog.query({ action: 'auth.denied' })).entries.length;
    await app.inject({ ...BAD['POST /api/users/:id/disable']!, headers: headers.family });
    const denied = (await deps.auditLog.query({ action: 'auth.denied' })).entries;
    expect(denied.length).toBe(before + 1);
    expect(denied.some((e) => e.target.type === 'role' && e.target.id === 'admin')).toBe(true);
  });

  it('正向：管理员账号和所有者照样走校验（坏请求体 / 坏 id → 400），合法请求成功', async () => {
    for (const k of ['POST /api/users/invites', 'POST /api/users/:id/disable'] as const) {
      expect((await app.inject({ ...BAD[k]!, headers: headers.admin })).statusCode, `${k} admin`).toBe(400);
      expect((await app.inject({ ...BAD[k]!, headers: ownerAuth })).statusCode, `${k} owner`).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: headers.admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/users/${MISSING_UUID}/disable`, headers: headers.admin })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: '/api/users/invites', headers: headers.admin, payload: { email: 'new-349@example.test' } });
    expect(ok.statusCode).toBe(201);
  });
});
