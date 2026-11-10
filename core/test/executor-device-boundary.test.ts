/**
 * #365（负责人裁定方向 1a，Core 侧）：/api/executor/* 只认带执行员范围的客户端令牌；
 * 设备令牌（只带执行员范围的客户端令牌）请求其他 /api 路由（及 /mcp、/internal、/api/clients/self）一律拒绝。
 * 混合范围令牌的取舍见 src/auth/plugin.ts isDeviceToken 的 shortcut 注释。
 * 执行员接口经 Shell 暴露在公网，这是边缘 Access 之外的第二道闸。
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';

const OP = 'placeholder-operator-token-exec-boundary-01';
const PW = 'correct-horse-battery';
const TASK = '00000000-0000-4000-8000-000000000001';

/** 全部执行员接口（新增接口要加进来） */
const EXECUTOR_ROUTES: ['GET' | 'POST', string, object?][] = [
  ['POST', '/api/executor/hello', { deviceName: 'pc', platform: 'win32', version: '0.1.0' }],
  ['POST', '/api/executor/tasks/claim', { waitSec: 0 }],
  ['POST', `/api/executor/tasks/${TASK}/progress`, { step: 'x' }],
  ['POST', `/api/executor/tasks/${TASK}/result`, { status: 'succeeded' }],
  ['POST', `/api/executor/tasks/${TASK}/secret`, { secretId: 's', field: 'password' }],
  ['POST', `/api/executor/tasks/${TASK}/takeover`, { reason: 'captcha' }],
  ['GET', `/api/executor/tasks/${TASK}/takeover/t1?waitSec=0`],
  ['POST', '/api/executor/nonexistent', {}],
];

/** 设备令牌不该进的路径：人用的任务 / 执行员管理、自查、其他模块、MCP、内部接口、不存在的 /api */
const OTHER_ROUTES: ['GET' | 'POST', string, object?][] = [
  ['GET', '/api/clients/self'],
  ['GET', '/api/clients'],
  ['GET', '/api/tasks'],
  ['GET', '/api/executors'],
  ['GET', '/api/executor-allowlist'],
  ['GET', '/api/memory'],
  ['GET', '/api/library'],
  ['GET', '/api/members'],
  ['GET', '/api/users'],
  ['GET', '/api/inbox'],
  ['GET', '/api/nope'],
  ['GET', '/api/%65xecutor-allowlist'],
  ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
  ['GET', '/internal/anything'],
];

describe('#365 执行员接口 ↔ 设备令牌 边界', () => {
  let app: FastifyInstance;
  let device: Record<string, string>;
  let deviceMixed: Record<string, string>;
  let deviceSecretOnly: Record<string, string>;
  let mcpClient: Record<string, string>;
  let readClient: Record<string, string>;
  let user: Record<string, string>;
  const op = { authorization: `Bearer ${OP}` };

  beforeAll(async () => {
    const deps = memoryDeps(fakeClock().now);
    (deps.operatorTokens as MemoryOperatorTokenStore).add({
      id: 'op',
      hmac: hmacToken(TOKEN_SECRET, OP),
      capabilities: ['members:read', 'inbox:read', 'inbox:post', 'keys:read'],
      revokedAt: null,
      expiresAt: null,
    });
    app = buildServer(
      loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_ACCESS_REAUTH: 'off', VAULT_KEY: randomBytes(32).toString('base64') }),
      deps,
    );
    const mk = async (scopes: string[]) => {
      const r = await app.inject({ method: 'POST', url: '/api/clients', headers: ownerAuth, payload: { name: 'c', scopes } });
      expect(r.statusCode).toBe(201);
      return { authorization: `Bearer ${r.json().token as string}` };
    };
    device = await mk(['tasks:pull']);
    deviceMixed = await mk(['tasks:pull', 'tasks:secret']);
    deviceSecretOnly = await mk(['tasks:secret']);
    mcpClient = await mk(['tasks:create', 'tasks:read', 'tools:list', 'tools:call']);
    readClient = await mk(['memory:read', 'library:read', 'bookmarks:read']);
    const inv = await app.inject({ method: 'POST', url: '/api/users/invites', headers: ownerAuth, payload: { email: 'bob@example.com' } });
    const acc = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
    user = { authorization: `Bearer ${acc.json().token as string}` };
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (h: Record<string, string>, [method, url, payload]: ['GET' | 'POST', string, object?]) =>
    app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });

  it('设备令牌可以 hello（放行基线）', async () => {
    expect((await call(device, EXECUTOR_ROUTES[0]!)).statusCode).toBe(200);
    expect((await call(deviceMixed, EXECUTOR_ROUTES[0]!)).statusCode).toBe(200);
  });

  it('所有者令牌、账号、操作员、MCP 客户端、只读客户端、无令牌：每个执行员接口都被拒', async () => {
    const who: [string, Record<string, string>][] = [
      ['所有者', ownerAuth],
      ['账号', user],
      ['操作员', op],
      ['MCP 客户端', mcpClient],
      ['只读客户端', readClient],
      ['无令牌', {}],
      ['乱写令牌', { authorization: 'Bearer arc_garbage' }],
    ];
    for (const [name, h] of who) {
      for (const r of EXECUTOR_ROUTES) {
        const res = await call(h, r);
        expect([401, 403], `${name} ${r[0]} ${r[1]} → ${res.statusCode}`).toContain(res.statusCode);
      }
    }
  });

  it('设备令牌（tasks:pull、tasks:pull+tasks:secret、只有 tasks:secret）请求其他 /api、/mcp、/internal：一律 403', async () => {
    for (const [name, h] of [
      ['tasks:pull', device],
      ['tasks:pull + tasks:secret', deviceMixed],
      ['tasks:secret', deviceSecretOnly],
    ] as const) {
      for (const r of OTHER_ROUTES) {
        const res = await call(h, r);
        expect(res.statusCode, `${name} ${r[0]} ${r[1]}`).toBe(403);
      }
    }
  });

  it('同样的其他接口，非设备令牌照旧能用（证明拒绝来自设备令牌边界，不是接口坏了）', async () => {
    expect((await call(readClient, ['GET', '/api/memory'])).statusCode).toBe(200);
    expect((await call(readClient, ['GET', '/api/clients/self'])).statusCode).toBe(200);
    expect((await call(ownerAuth, ['GET', '/api/executors'])).statusCode).toBe(200);
  });
});
