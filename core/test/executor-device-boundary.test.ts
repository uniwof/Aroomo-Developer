/**
 * #365（负责人裁定方向 1a，Core 侧）+ #376 第 1 轮 M3 / M4：
 *  - /api/executor/* 只认设备令牌（只带 tasks:pull / tasks:secret 的客户端令牌）；
 *  - 带执行员范围的令牌请求其他接口（/api、/mcp、/internal、/v1、/auth）一律拒绝；
 *  - 签发时禁止混合范围（400 MIXED_SCOPES）；已签发的混合令牌两边都进不去（失败即关闭）；
 *  - 每类凭据一个确定状态码；403 时恰好新增一条 auth.denied 审计（401 和钩子外的接口不写）。
 * 执行员接口经 Shell 暴露在公网，这是边缘 Access 之外的第二道闸。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';

const OP = 'placeholder-operator-token-exec-boundary-01';
const CHAT = 'placeholder-chat-token-exec-boundary-000000';
const PW = 'correct-horse-battery';
const TASK = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';

type Route = ['GET' | 'POST' | 'PUT' | 'DELETE', string, object?];

/** 全部执行员接口（新增接口要加进来） */
const EXECUTOR_ROUTES: Route[] = [
  ['POST', '/api/executor/hello', { deviceName: 'pc', platform: 'win32', version: '0.1.0' }],
  ['POST', '/api/executor/tasks/claim', { waitSec: 0 }],
  ['POST', `/api/executor/tasks/${TASK}/progress`, { step: 'x' }],
  ['POST', `/api/executor/tasks/${TASK}/result`, { status: 'succeeded' }],
  ['POST', `/api/executor/tasks/${TASK}/secret`, { secretId: 's', field: 'password' }],
  ['POST', `/api/executor/tasks/${TASK}/takeover`, { reason: 'captcha' }],
  ['GET', `/api/executor/tasks/${TASK}/takeover/t1?waitSec=0`],
  ['POST', '/api/executor/nonexistent', {}],
];

/**
 * 带执行员范围的令牌不该进的路径，每条一个确定状态码；audit = 是否经过鉴权钩子（写一条 auth.denied）。
 * /v1、/auth 不在钩子里：/v1 由对话入口自己认令牌（只认 models:chat 且不带执行员范围的客户端令牌）→ 401；/auth 不读 Bearer，结果与不带令牌完全一样。
 */
const OTHER_ROUTES: [...Route, number, boolean][] = [
  ['GET', '/api/clients/self', undefined, 403, true],
  ['GET', '/api/clients', undefined, 403, true],
  ['POST', '/api/clients', { name: 'x', scopes: ['library:read'] }, 403, true],
  ['DELETE', `/api/clients/${CLIENT_ID}`, undefined, 403, true],
  ['GET', '/api/tasks', undefined, 403, true],
  ['POST', '/api/tasks', { kind: 'browse', site: 'https://example.com/' }, 403, true],
  ['GET', '/api/executors', undefined, 403, true],
  ['GET', '/api/executor-allowlist', undefined, 403, true],
  ['PUT', '/api/executor-allowlist', { sites: ['https://evil.example'] }, 403, true],
  ['GET', '/api/memory', undefined, 403, true],
  ['GET', '/api/library', undefined, 403, true],
  ['GET', '/api/members', undefined, 403, true],
  ['GET', '/api/users', undefined, 403, true],
  ['GET', '/api/inbox', undefined, 403, true],
  ['GET', '/api/nope', undefined, 403, true],
  ['GET', '/api/%65xecutor-allowlist', undefined, 403, true],
  ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 403, true],
  ['GET', '/internal/anything', undefined, 403, true],
  ['GET', '/v1/models', undefined, 401, false],
  ['POST', '/v1/chat/completions', { model: 'aroomo/auto', messages: [{ role: 'user', content: 'hi' }] }, 401, false],
  ['POST', '/v1/responses', { model: 'aroomo/auto', input: 'hi' }, 401, false],
  ['POST', '/auth/login', { email: 'bob@example.com', password: 'wrong-password-123' }, 401, false],
  ['POST', '/auth/accept', { token: 'not-a-real-invite-token', password: 'another-password-123' }, 400, false],
];

describe('#365 / #376 执行员接口 ↔ 设备令牌 边界', () => {
  let app: FastifyInstance;
  let deps: ReturnType<typeof memoryDeps>;
  let device: Record<string, string>;
  let deviceBoth: Record<string, string>;
  let deviceSecretOnly: Record<string, string>;
  let legacyMixed: Record<string, string>;
  let mcpClient: Record<string, string>;
  let readClient: Record<string, string>;
  let chatClient: Record<string, string>;
  let user: Record<string, string>;
  const op = { authorization: `Bearer ${OP}` };

  beforeAll(async () => {
    deps = memoryDeps(fakeClock().now);
    (deps.operatorTokens as MemoryOperatorTokenStore).add({
      id: 'op',
      hmac: hmacToken(TOKEN_SECRET, OP),
      capabilities: ['members:read', 'inbox:read', 'inbox:post', 'keys:read'],
      revokedAt: null,
      expiresAt: null,
    });
    app = buildServer(
      loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_CHAT_TOKEN: CHAT, CORE_ACCESS_REAUTH: 'off', VAULT_KEY: randomBytes(32).toString('base64') }),
      deps,
    );
    const mk = async (scopes: string[]) => {
      const r = await app.inject({ method: 'POST', url: '/api/clients', headers: ownerAuth, payload: { name: 'c', scopes } });
      expect(r.statusCode, r.body).toBe(201);
      return { authorization: `Bearer ${r.json().token as string}` };
    };
    device = await mk(['tasks:pull']);
    deviceBoth = await mk(['tasks:pull', 'tasks:secret']);
    deviceSecretOnly = await mk(['tasks:secret']);
    mcpClient = await mk(['tasks:create', 'tasks:read', 'tools:list', 'tools:call']);
    readClient = await mk(['memory:read', 'library:read', 'bookmarks:read']);
    chatClient = await mk(['models:chat']);
    // 本 PR 之前签发的混合令牌（现在签不出来了）：直接写进库，模拟存量
    const legacy = `arc_${randomBytes(32).toString('base64url')}`;
    await deps.clients.insert({
      id: randomUUID(),
      userId: 'owner',
      name: 'legacy mixed',
      tokenHash: createHash('sha256').update(legacy, 'utf8').digest('hex'),
      scopes: ['tasks:pull', 'tasks:secret', 'models:chat', 'memory:read', 'tools:call'],
      rateLimitPerMin: 6000,
      createdAt: new Date(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    legacyMixed = { authorization: `Bearer ${legacy}` };
    const inv = await app.inject({ method: 'POST', url: '/api/users/invites', headers: ownerAuth, payload: { email: 'bob@example.com' } });
    const acc = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
    user = { authorization: `Bearer ${acc.json().token as string}` };
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (h: Record<string, string>, [method, url, payload]: Route) => app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
  const denials = async () => (await deps.auditLog.query({ action: 'auth.denied', limit: 200 })).entries.length;
  /** 发一次请求：状态码必须恰为 status；403 时恰好新增一条 auth.denied，其余不新增 */
  const expectDenied = async (label: string, h: Record<string, string>, r: Route, status: number, audited = status === 403) => {
    const before = await denials();
    const res = await call(h, r);
    expect(res.statusCode, `${label} ${r[0]} ${r[1]} → ${res.body.slice(0, 200)}`).toBe(status);
    expect((await denials()) - before, `${label} ${r[0]} ${r[1]} 新增 auth.denied 条数`).toBe(audited ? 1 : 0);
  };

  it('设备令牌可以 hello（放行基线）', async () => {
    for (const h of [device, deviceBoth]) expect((await call(h, EXECUTOR_ROUTES[0]!)).statusCode).toBe(200);
  });

  it('每类非设备凭据打每个执行员接口：状态码写死，403 恰好一条 auth.denied，401 不写', async () => {
    const who: [string, Record<string, string>, number][] = [
      ['所有者', ownerAuth, 403],
      ['账号', user, 403],
      ['操作员', op, 403],
      ['MCP 客户端', mcpClient, 403],
      ['只读客户端', readClient, 403],
      ['对话客户端', chatClient, 403],
      ['存量混合令牌', legacyMixed, 403],
      ['无令牌', {}, 401],
      ['乱写令牌', { authorization: 'Bearer arc_garbage' }, 401],
    ];
    for (const [name, h, status] of who) for (const r of EXECUTOR_ROUTES) await expectDenied(name, h, r, status);
  });

  it('带执行员范围的令牌（tasks:pull、tasks:pull+tasks:secret、只有 tasks:secret、存量混合令牌）打其他接口：状态码写死，审计按表', async () => {
    for (const [name, h] of [
      ['tasks:pull', device],
      ['tasks:pull + tasks:secret', deviceBoth],
      ['tasks:secret', deviceSecretOnly],
      ['存量混合令牌', legacyMixed],
    ] as const) {
      for (const [m, u, p, status, audited] of OTHER_ROUTES) await expectDenied(name, h, [m, u, p], status, audited);
    }
  });

  it('/auth/*：带设备令牌和不带令牌结果完全一样（设备令牌在那里不起任何作用）', async () => {
    for (const [m, u, p0, status] of OTHER_ROUTES.filter((r) => r[1].startsWith('/auth/'))) {
      // 换一个邮箱，避开上一条用例在 bob 上累计的登录失败限速
      const p = u === '/auth/login' ? { ...p0, email: 'carol@example.com' } : p0;
      const anon = await call({}, [m, u, p]);
      const dev = await call(device, [m, u, p]);
      expect([dev.statusCode, dev.json().error?.code]).toEqual([anon.statusCode, anon.json().error?.code]);
      expect(dev.statusCode).toBe(status);
    }
  });

  it('正向对照：同样的接口，非设备凭据照旧能用（证明拒绝来自设备令牌边界，不是接口坏了）', async () => {
    expect((await call(readClient, ['GET', '/api/memory'])).statusCode).toBe(200);
    expect((await call(readClient, ['GET', '/api/clients/self'])).statusCode).toBe(200);
    expect((await call(ownerAuth, ['GET', '/api/executors'])).statusCode).toBe(200);
    expect((await call(ownerAuth, ['PUT', '/api/executor-allowlist', { sites: ['https://example.com'] }])).statusCode).toBe(200);
    expect((await call(chatClient, ['GET', '/v1/models'])).statusCode).toBe(200);
  });

  it('M4 签发：带执行员范围就不能再带别的范围 → 400 MIXED_SCOPES，且没有多出令牌；纯设备 / 纯非设备照常签发', async () => {
    const count = async () => ((await call(ownerAuth, ['GET', '/api/clients'])).json().clients as unknown[]).length;
    const before = await count();
    for (const scopes of [['tasks:pull', 'models:chat'], ['tasks:secret', 'memory:read'], ['tasks:pull', 'tasks:secret', 'tasks:create'], ['tasks:pull', 'tools:call']]) {
      const r = await call(ownerAuth, ['POST', '/api/clients', { name: 'mixed', scopes }]);
      expect([r.statusCode, r.json().error?.code], scopes.join(',')).toEqual([400, 'MIXED_SCOPES']);
      expect(r.body).not.toMatch(/arc_/);
    }
    expect(await count()).toBe(before);
    for (const scopes of [['tasks:pull', 'tasks:secret'], ['tasks:create', 'tasks:read', 'models:chat']]) {
      expect((await call(ownerAuth, ['POST', '/api/clients', { name: 'ok', scopes }])).statusCode, scopes.join(',')).toBe(201);
    }
  });
});
