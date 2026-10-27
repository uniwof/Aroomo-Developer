import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bindAudit } from '../src/audit/common.js';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, TOKEN_SECRET, fakeClock, ownerAuth } from './helpers/db.js';

const OP = 'placeholder-operator-token-inbox-0001';
const opAuth = { authorization: `Bearer ${OP}` };

describe('/api/inbox HTTP', () => {
  let app: FastifyInstance;
  let deps: CoreDeps;
  let clock: ReturnType<typeof fakeClock>;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    clock = fakeClock();
    deps = memoryDeps(clock.now);
    (deps.operatorTokens as MemoryOperatorTokenStore).add({
      id: 'op',
      hmac: hmacToken(TOKEN_SECRET, OP),
      capabilities: ['inbox:read', 'inbox:act', 'inbox:confirm-irreversible'],
      revokedAt: null,
      expiresAt: null,
    });
    app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET }), deps);
    apps.push(app);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  const sys = () => bindAudit(deps.auditLog, { type: 'system', id: 'test' });
  const seed = async (title: string, group: 'decision' | 'candidate' | 'brief' = 'decision') =>
    (
      await app.inbox.createInboxItem(
        {
          group,
          kind: 'k',
          title,
          actions: [
            { id: 'ok', label: '同意' },
            { id: 'delete', label: '永久删除', irreversible: true },
          ],
        },
        sys(),
      )
    ).item;
  const post = (url: string, payload?: object, headers = ownerAuth) =>
    app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });

  it('GET /api/inbox：按组返回；?group= 返回单组；非法参数 400；无令牌 401', async () => {
    await seed('d1');
    await seed('c1', 'candidate');
    const all = (await app.inject({ method: 'GET', url: '/api/inbox', headers: ownerAuth })).json();
    expect(Object.keys(all.groups)).toEqual(['decision', 'candidate', 'brief']);
    expect(all.groups.decision[0].title).toBe('d1');
    const one = (await app.inject({ method: 'GET', url: '/api/inbox?group=candidate', headers: ownerAuth })).json();
    expect(one.items.map((i: { title: string }) => i.title)).toEqual(['c1']);
    expect((await app.inject({ method: 'GET', url: '/api/inbox?group=nope', headers: ownerAuth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/inbox' })).statusCode).toBe(401);
  });

  it('GET /api/inbox/unread-count', async () => {
    await seed('d1');
    await seed('b1', 'brief');
    const r = await app.inject({ method: 'GET', url: '/api/inbox/unread-count', headers: ownerAuth });
    expect(r.json()).toEqual({ total: 2, byGroup: { decision: 1, candidate: 0, brief: 1 } });
  });

  it('POST actions：200；重复 409；并发两次只有一个 200；未知动作 400；不存在 404', async () => {
    const a = await seed('a');
    const r = await post(`/api/inbox/${a.id}/actions/ok`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ needsConfirm: false, item: { status: 'done', resolvedAction: 'ok' } });
    expect((await post(`/api/inbox/${a.id}/actions/ok`)).statusCode).toBe(409);
    const b = await seed('b');
    const codes = (await Promise.all([post(`/api/inbox/${b.id}/actions/ok`), post(`/api/inbox/${b.id}/actions/ok`)])).map((x) => x.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const c = await seed('c');
    expect((await post(`/api/inbox/${c.id}/actions/zzz`)).statusCode).toBe(400);
    expect((await post(`/api/inbox/00000000-0000-0000-0000-000000000000/actions/ok`)).statusCode).toBe(404);
    expect((await post(`/api/inbox/not-a-uuid/actions/ok`)).statusCode).toBe(400);
  });

  it('不可逆动作二次确认：needsConfirm → 带 token 执行 → 重放 409；过期 409', async () => {
    const a = await seed('a');
    const first = await post(`/api/inbox/${a.id}/actions/delete`);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ needsConfirm: true });
    expect(typeof body.confirmToken).toBe('string');
    const exec = await post(`/api/inbox/${a.id}/actions/delete`, { confirmToken: body.confirmToken });
    expect(exec.json()).toMatchObject({ needsConfirm: false, item: { status: 'done', resolvedAction: 'delete' } });
    expect((await post(`/api/inbox/${a.id}/actions/delete`, { confirmToken: body.confirmToken })).statusCode).toBe(409);

    const b = await seed('b');
    const t = (await post(`/api/inbox/${b.id}/actions/delete`)).json().confirmToken;
    clock.advance(5 * 60 * 1000 + 1);
    const late = await post(`/api/inbox/${b.id}/actions/delete`, { confirmToken: t });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('CONFIRM_EXPIRED');
  });

  it('操作员：可读、可执行普通动作；不可逆动作即使令牌写了 confirm 能力也 403（白名单外）', async () => {
    const a = await seed('a');
    expect((await app.inject({ method: 'GET', url: '/api/inbox', headers: opAuth })).statusCode).toBe(200);
    expect((await post(`/api/inbox/${a.id}/actions/delete`, undefined, opAuth)).statusCode).toBe(403);
    expect((await post(`/api/inbox/${a.id}/actions/ok`, undefined, opAuth)).statusCode).toBe(200);
  });

  it('POST dismiss（单条 / 批量）', async () => {
    const a = await seed('a');
    const b = await seed('b');
    expect((await post(`/api/inbox/${a.id}/dismiss`)).json().item.status).toBe('dismissed');
    expect((await post(`/api/inbox/${a.id}/dismiss`)).statusCode).toBe(409);
    const r = await post('/api/inbox/dismiss', { ids: [a.id, b.id] });
    expect(r.json()).toEqual({ dismissed: [b.id], skipped: [{ id: a.id, reason: 'ALREADY_RESOLVED' }] });
    expect((await post('/api/inbox/dismiss', { ids: [] })).statusCode).toBe(400);
  });
});
