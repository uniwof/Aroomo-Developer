import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';

const OPERATOR_TOKEN = 'placeholder-operator-token-0123456789';

describe('GET /api/audit 与鉴权', () => {
  let app: FastifyInstance;
  const clock = fakeClock();
  const deps = memoryDeps(clock.now);

  beforeAll(async () => {
    const ops = deps.operatorTokens as MemoryOperatorTokenStore;
    // 令牌里写了白名单外的 audit:read，也不应生效（D36）
    ops.add({ id: 'op-1', hmac: hmacToken(TOKEN_SECRET, OPERATOR_TOKEN), capabilities: ['members:read', 'audit:read'], revokedAt: null, expiresAt: null });
    app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET }), deps);
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1000);
      await deps.auditLog.append({ actor: { type: 'owner', id: 'owner' }, action: 'members.create', target: { type: 'member', id: `m${i}` }, result: 'ok' });
    }
  });
  afterAll(() => app.close());

  it('无令牌 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('错误令牌 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { authorization: 'Bearer wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('主人可分页查询', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/api/audit?limit=2', headers: ownerAuth });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.entries).toHaveLength(2);
    expect(typeof b1.entries[0].ts).toBe('string');
    const r2 = await app.inject({ method: 'GET', url: `/api/audit?limit=2&cursor=${b1.nextCursor}`, headers: ownerAuth });
    expect(r2.json().entries[0].id).not.toBe(b1.entries[0].id);
  });

  it('参数不合法 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audit?limit=0', headers: ownerAuth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/audit?cursor=zzz', headers: ownerAuth })).statusCode).toBe(400);
  });

  it('没有写接口', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/audit', headers: ownerAuth });
      expect(res.statusCode).toBe(404);
    }
  });

  it('操作员：白名单外的 audit:read 被拒绝（403）并写审计 denied', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(res.statusCode).toBe(403);
    const page = await deps.auditLog.query({ action: 'auth.denied' });
    expect(page.entries[0]).toMatchObject({ actor: { type: 'operator', id: 'op-1' }, result: 'denied', target: { id: 'audit:read' } });
  });

  it('未配置主人令牌时 /api 一律 503', async () => {
    const bare = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent' }));
    const res = await bare.inject({ method: 'GET', url: '/api/audit', headers: ownerAuth });
    expect(res.statusCode).toBe(503);
    expect((await bare.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await bare.close();
  });
});
