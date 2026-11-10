/**
 * #349：adminGuard 的管理员检查挂在 preValidation（请求体 / 参数校验之前），未授权请求先拿 401/403，不先拿 schema 400。
 * 越权反向：无令牌、家人（普通账号）令牌、错误角色（操作员令牌、家人的客户端令牌）。正向：管理员照样走校验（坏请求体 400）。
 * 结构（#358 M2）：按 adminGuard 打的 config.adminOnly 标记找管理员路由，每条的 preValidation 必须含 requireAdmin、preHandler 不含
 * （防止挂回校验之后，也防止 `{ ...adminGuard(), preValidation: x }` 把检查覆盖掉）。
 * 测试里全是占位凭据，和任何真实账号、真实密钥无关。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type InjectOptions } from 'fastify';
import { adminGuard, requireAdmin } from '../src/auth/plugin.js';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { HttpError } from '../src/http/errors.js';
import { seedXiaohao } from '../src/users/seed.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';
import { fakePw } from './helpers/two-accounts.js';
import { type SeenRoute, seenRoutes } from './authz/route-registry.js';

vi.mock('fastify', async (orig) => (await import('./authz/route-registry.js')).wrapFastify(await orig<typeof import('fastify')>()));

const OP = 'placeholder-operator-token-admin-349';
const MISSING_UUID = '00000000-0000-4000-8000-000000000349';

let app: FastifyInstance;
let deps: CoreDeps;
const headers: Record<'family' | 'familyClient' | 'operator' | 'admin', Record<string, string>> = {} as never;
let familyUserId = '';

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
    if (email.startsWith('family-')) familyUserId = r.json().user.id as string;
    return { authorization: `Bearer ${r.json().token as string}` };
  };
  headers.family = await login('family-349@example.test', famPw);
  expect(familyUserId).not.toBe('');
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

/**
 * 每条管理员路由的「坏请求」（以这份名单为准，#358 M1）：管理员 / 所有者必须拿到 schema 校验的 400（BAD_REQUEST + fields），
 * 其他人必须先拿 401/403。body 多字段 / 缺字段；params 不是 uuid（idParams 有 format: 'uuid'，非法 id 是 400 不是 404）。
 * GET /api/users 没有任何输入 schema（无 body / params / query 可校验），执行顺序对它不可观察：正向对照断言 200，列在 NO_INPUT。
 */
const BAD: Record<string, InjectOptions> = {
  'GET /api/users': { method: 'GET', url: '/api/users' },
  'POST /api/users/invites': { method: 'POST', url: '/api/users/invites', payload: { role: 'root', extra: 1 } },
  'POST /api/users/:id/disable': { method: 'POST', url: '/api/users/not-a-uuid/disable' },
  'POST /api/users/:id/enable': { method: 'POST', url: '/api/users/not-a-uuid/enable' },
  'POST /api/users/:id/reset-link': { method: 'POST', url: '/api/users/not-a-uuid/reset-link' },
};
const NO_INPUT = new Set(['GET /api/users']);

const byKey = (routes: SeenRoute[]) => new Map(routes.map((r) => [`${r.method} ${r.url}`, r]));
/** 管理员路由 = adminGuard 打了 adminOnly 标记的（不按「钩子里有没有 requireAdmin」找：被覆盖的路由会从名单里消失） */
const adminOnlyKeys = (routes: SeenRoute[]) => [...byKey(routes)].filter(([, r]) => r.config.adminOnly === true).map(([k]) => k);
/** 结构违规：adminOnly 路由的 preValidation 不含 requireAdmin，或 requireAdmin 挂在 preHandler */
const structureViolations = (routes: SeenRoute[]) =>
  [...byKey(routes)]
    .filter(([, r]) => r.config.adminOnly === true)
    .flatMap(([k, r]) => [
      ...(r.preValidation.includes(requireAdmin) ? [] : [`${k} preValidation 不含 requireAdmin`]),
      ...(r.preHandler.includes(requireAdmin) ? [`${k} requireAdmin 在 preHandler`] : []),
    ]);
/** 名单里的路由必须在注册表里（且带 adminOnly），找不到就失败；不靠可能为空的遍历 */
const registered = (k: string) => {
  const r = byKey(seenRoutes).get(k);
  expect(r, `${k} 没注册`).toBeDefined();
  expect(r!.config.adminOnly, `${k} 没有 adminOnly 标记`).toBe(true);
  return BAD[k]!;
};
const schema400 = (res: { statusCode: number; json: () => { error?: { code?: string; fields?: unknown } } }) =>
  res.statusCode === 400 && res.json().error?.code === 'BAD_REQUEST' && Array.isArray(res.json().error?.fields) && (res.json().error!.fields as unknown[]).length > 0;

describe('#349 adminGuard 在请求体校验之前', () => {
  it('结构：adminGuard() 打 adminOnly 标记，requireAdmin 在 preValidation 第一个；额外钩子排在后面；不给 preHandler', () => {
    const extra = async () => {};
    const g = adminGuard(extra) as unknown as Record<string, unknown>;
    expect(g.config).toEqual({ userRoute: true, adminOnly: true });
    expect(g.preValidation).toEqual([requireAdmin, extra]);
    expect(g.preHandler).toBeUndefined();
    expect((adminGuard() as unknown as Record<string, unknown>).preValidation).toEqual([requireAdmin]);
  });

  it('结构：每条 adminOnly 路由的 preValidation 都含 requireAdmin，没有一条在 preHandler；adminOnly 路由 == BAD 名单', () => {
    expect(adminOnlyKeys(seenRoutes).sort(), '新增 adminGuard 路由要在 BAD 里补坏请求').toEqual(Object.keys(BAD).sort());
    expect(structureViolations(seenRoutes)).toEqual([]);
  });

  it('回退自检：`{ ...adminGuard(), preValidation: x }` 覆盖掉 requireAdmin 时，结构检查必须报出来', async () => {
    const start = seenRoutes.length;
    const tmp = Fastify();
    try {
      tmp.post('/tmp/override', { ...adminGuard(), preValidation: async () => {} }, async () => ({}));
      tmp.post('/tmp/extra', { ...adminGuard(async () => {}) }, async () => ({}));
      await tmp.ready();
    } finally {
      await tmp.close();
    }
    const mine = seenRoutes.splice(start); // 临时路由不留在全局注册表里
    expect(adminOnlyKeys(mine).sort()).toEqual(['POST /tmp/extra', 'POST /tmp/override']);
    expect(structureViolations(mine)).toEqual(['POST /tmp/override preValidation 不含 requireAdmin']);
  });

  it('复现：家人令牌 + 非法请求体 → 403（修前是 400 校验错误）', async () => {
    const r = await app.inject({ ...registered('POST /api/users/invites'), headers: headers.family });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
    expect(r.body).not.toMatch(/body|must have|additional|required/i);
  });

  it('越权反向：BAD 名单每条，无令牌 401；家人、家人客户端令牌、操作员 403；均不先 400', async () => {
    const wrong: string[] = [];
    for (const k of Object.keys(BAD)) {
      const bad = registered(k);
      const none = await app.inject(bad);
      if (none.statusCode !== 401) wrong.push(`${k} 无令牌 → ${none.statusCode}`);
      for (const who of ['family', 'familyClient', 'operator'] as const) {
        const res = await app.inject({ ...bad, headers: headers[who] });
        if (res.statusCode !== 403 || res.json().error.code !== 'FORBIDDEN') wrong.push(`${k} ${who} → ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('正向对照：BAD 名单每条，管理员账号和所有者都拿 schema 400（BAD_REQUEST + fields）；无输入的 GET 200', async () => {
    const wrong: string[] = [];
    for (const k of Object.keys(BAD)) {
      const bad = registered(k);
      for (const [who, h] of [['admin', headers.admin], ['owner', ownerAuth]] as const) {
        const res = await app.inject({ ...bad, headers: h });
        const ok = NO_INPUT.has(k) ? res.statusCode === 200 : schema400(res);
        if (!ok) wrong.push(`${k} ${who} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(wrong).toEqual([]);
    // 合法请求能进处理器
    expect((await app.inject({ method: 'POST', url: `/api/users/${MISSING_UUID}/disable`, headers: headers.admin })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: '/api/users/invites', headers: headers.admin, payload: { email: 'new-349@example.test' } });
    expect(ok.statusCode).toBe(201);
  });

  it('审计：家人被拒正好新增一条 auth.denied，逐字段严格；管理员发同样请求不写 auth.denied', async () => {
    const denied = async () => (await deps.auditLog.query({ action: 'auth.denied', limit: 200 })).entries;
    const bad = registered('POST /api/users/:id/disable');
    const beforeIds = new Set((await denied()).map((e) => e.id));
    expect((await app.inject({ ...bad, headers: headers.family })).statusCode).toBe(403);
    const added = (await denied()).filter((e) => !beforeIds.has(e.id));
    expect(added).toHaveLength(1);
    const e = added[0]!;
    expect({ actor: e.actor, action: e.action, target: e.target, result: e.result, note: e.note }).toEqual({
      actor: { type: 'user', id: familyUserId },
      action: 'auth.denied',
      target: { type: 'role', id: 'admin' },
      result: 'denied',
      note: 'POST /api/users/:id/disable',
    });

    const beforeAdmin = new Set((await denied()).map((e) => e.id));
    expect(schema400(await app.inject({ ...bad, headers: headers.admin }))).toBe(true);
    expect((await denied()).filter((e) => !beforeAdmin.has(e.id))).toEqual([]);
  });
});

/** requireAdmin 自己能拦（不靠 onRequest 先挡）：直接喂伪造的身份对象 */
describe('requireAdmin 单元：伪造身份', () => {
  const call = async (principal: unknown) => {
    const audit = vi.fn(async () => {});
    const req = { principal, method: 'POST', routeOptions: { url: '/x/:id' }, audit } as unknown as FastifyRequest;
    let err: unknown = null;
    try {
      await requireAdmin.call({} as FastifyInstance, req, {} as FastifyReply);
    } catch (e) {
      err = e;
    }
    return { err: err as HttpError | null, audit };
  };

  it('无身份 → 401，不写审计', async () => {
    const { err, audit } = await call(null);
    expect(err).toBeInstanceOf(HttpError);
    expect([err!.statusCode, err!.code]).toEqual([401, 'UNAUTHORIZED']);
    expect(audit).not.toHaveBeenCalled();
  });

  it('所有者、admin 账号 → 放行，不写审计', async () => {
    for (const p of [{ type: 'owner', id: 'owner' }, { type: 'user', userId: 'u-admin', role: 'admin' }]) {
      const { err, audit } = await call(p);
      expect(err).toBeNull();
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it('普通账号、带全部能力的操作员、客户端令牌 → 403 并写 auth.denied（role=admin）', async () => {
    const all = [
      { type: 'user', userId: 'u-fam', role: 'user' },
      { type: 'user', userId: 'u-x', role: 'owner' }, // 未知角色也不放行
      { type: 'operator', id: 'op', capabilities: new Set(['members:read', 'settings:write', 'confirm:important']) },
      { type: 'client', clientId: 'c1', userId: 'u-admin', scopes: new Set(['memory:read']) },
    ];
    for (const p of all) {
      const { err, audit } = await call(p);
      expect(err).toBeInstanceOf(HttpError);
      expect([err!.statusCode, err!.code]).toEqual([403, 'FORBIDDEN']);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith('auth.denied', { type: 'role', id: 'admin' }, 'denied', 'POST /x/:id');
    }
  });
});
