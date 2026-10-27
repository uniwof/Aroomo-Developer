import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';

const OP = 'placeholder-operator-token-members-01';
const opAuth = { authorization: `Bearer ${OP}` };

describe('/api/members HTTP', () => {
  let app: FastifyInstance;
  let deps: CoreDeps;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    deps = memoryDeps(fakeClock().now);
    (deps.operatorTokens as MemoryOperatorTokenStore).add({
      id: 'op',
      hmac: hmacToken(TOKEN_SECRET, OP),
      capabilities: ['members:read', 'members:write', 'members:purge'],
      revokedAt: null,
      expiresAt: null,
    });
    app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET }), deps);
    apps.push(app);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown, headers = ownerAuth) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('POST 201 / 400 / 409', async () => {
    const r = await req('POST', '/api/members', { name: 'Groq', capabilityTags: ['text'] });
    expect(r.statusCode).toBe(201);
    expect(r.json().member).toMatchObject({ id: 'groq', name: 'Groq', deletedAt: null });
    expect((await req('POST', '/api/members', {})).statusCode).toBe(400);
    expect((await req('POST', '/api/members', { name: 'X', capabilityTags: ['telepathy'] })).statusCode).toBe(400);
    expect((await req('POST', '/api/members', { name: 'X', extra: 1 })).statusCode).toBe(400);
    expect((await req('POST', '/api/members', { name: 'x', id: 'NO!' })).json().error.code).toBe('INVALID_ID');
    const dup = await req('POST', '/api/members', { name: 'groq' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'DUPLICATE_NAME' });
  });

  it('GET 200（默认不含已删除；?deleted=true 为回收站）', async () => {
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    await req('POST', '/api/members', { id: 'b', name: 'B' });
    await req('DELETE', '/api/members/a');
    expect((await req('GET', '/api/members')).json().members.map((m: { id: string }) => m.id)).toEqual(['b']);
    expect((await req('GET', '/api/members?deleted=true')).json().members.map((m: { id: string }) => m.id)).toEqual(['a']);
  });

  it('PATCH 200 / 400（空体）/ 404 / 409', async () => {
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    await req('POST', '/api/members', { id: 'b', name: 'B' });
    expect((await req('PATCH', '/api/members/a', { enabled: false })).json().member.enabled).toBe(false);
    expect((await req('PATCH', '/api/members/a', {})).statusCode).toBe(400);
    expect((await req('PATCH', '/api/members/zz', { name: 'Z' })).statusCode).toBe(404);
    expect((await req('PATCH', '/api/members/a', { name: 'b' })).statusCode).toBe(409);
  });

  it('DELETE / restore / purge：200、404、409（无 confirm）、204', async () => {
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    expect((await req('DELETE', '/api/members/a')).statusCode).toBe(200);
    expect((await req('DELETE', '/api/members/a')).statusCode).toBe(404);
    expect((await req('POST', '/api/members/a/restore')).statusCode).toBe(200);
    expect((await req('POST', '/api/members/a/restore')).statusCode).toBe(404);
    await req('DELETE', '/api/members/a');
    const noConfirm = await req('POST', '/api/members/a/purge');
    expect(noConfirm.statusCode).toBe(409);
    expect(noConfirm.json().error.code).toBe('CONFIRM_REQUIRED');
    expect((await req('POST', '/api/members/a/purge', { confirm: false })).statusCode).toBe(409);
    expect((await req('POST', '/api/members/a/purge', { confirm: true })).statusCode).toBe(204);
    expect((await req('POST', '/api/members/a/purge', { confirm: true })).statusCode).toBe(404);
  });

  it('置顶 PUT / 取消 DELETE；不存在 404', async () => {
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    await req('POST', '/api/members', { id: 'b', name: 'B' });
    expect((await req('PUT', '/api/members/b/pin')).json().member.pinned).toBe(true);
    expect((await req('GET', '/api/members')).json().members[0].id).toBe('b');
    expect((await req('DELETE', '/api/members/b/pin')).json().member.pinned).toBe(false);
    expect((await req('PUT', '/api/members/zz/pin')).statusCode).toBe(404);
  });

  it('重排 PUT /api/members/order：200 / 400', async () => {
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    await req('POST', '/api/members', { id: 'b', name: 'B' });
    const r = await req('PUT', '/api/members/order', { ids: ['b', 'a'] });
    expect(r.statusCode).toBe(200);
    expect(r.json().members.map((m: { id: string }) => m.id)).toEqual(['b', 'a']);
    expect((await req('PUT', '/api/members/order', { ids: ['b'] })).statusCode).toBe(400);
    expect((await req('PUT', '/api/members/order', {})).statusCode).toBe(400);
  });

  it('鉴权：无令牌 401；操作员只有白名单内的 members:read（写/彻底删除 403 并留审计）', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/members' })).statusCode).toBe(401);
    expect((await req('GET', '/api/members', undefined, opAuth)).statusCode).toBe(200);
    expect((await req('POST', '/api/members', { name: 'X' }, opAuth)).statusCode).toBe(403);
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    await req('DELETE', '/api/members/a');
    expect((await req('POST', '/api/members/a/purge', { confirm: true }, opAuth)).statusCode).toBe(403);
    const denied = await deps.auditLog.query({ action: 'auth.denied' });
    expect(denied.entries.map((e) => e.target.id)).toEqual(['members:purge', 'members:write']);
  });

  it('每个写操作都有审计记录', async () => {
    await req('POST', '/api/members', { id: 'a', name: 'A' });
    await req('PATCH', '/api/members/a', { name: 'AA' });
    await req('PUT', '/api/members/a/pin');
    await req('PUT', '/api/members/order', { ids: ['a'] });
    await req('DELETE', '/api/members/a');
    await req('POST', '/api/members/a/restore');
    const actions = (await deps.auditLog.query({ limit: 50 })).entries.map((e) => e.action).reverse();
    expect(actions).toEqual(['members.create', 'members.update', 'members.pin', 'members.reorder', 'members.delete', 'members.restore']);
  });
});
