import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bindAudit } from '../src/audit/common.js';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { confirmOverHttp } from './helpers/confirm.js';
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
      // 令牌里写了白名单外 / 禁止的能力也不生效（D62）
      capabilities: ['inbox:post', 'inbox:read', 'inbox:act', 'confirm:important'],
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
            { id: 'delete', label: '永久删除', confirm: { kind: 'irreversible', consequences: ['删除后无法恢复。'] } },
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
    expect(r.json()).toMatchObject({ item: { status: 'done', resolvedAction: 'ok' } });
    expect((await post(`/api/inbox/${a.id}/actions/ok`)).statusCode).toBe(409);
    const b = await seed('b');
    const codes = (await Promise.all([post(`/api/inbox/${b.id}/actions/ok`), post(`/api/inbox/${b.id}/actions/ok`)])).map((x) => x.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const c = await seed('c');
    expect((await post(`/api/inbox/${c.id}/actions/zzz`)).statusCode).toBe(400);
    expect((await post(`/api/inbox/00000000-0000-0000-0000-000000000000/actions/ok`)).statusCode).toBe(404);
    expect((await post(`/api/inbox/not-a-uuid/actions/ok`)).statusCode).toBe(400);
  });

  it('重要动作（不可逆）：428 + challenge → 两步确认 → 带令牌执行 → 重放 409；过期 409', async () => {
    const a = await seed('a');
    const first = await post(`/api/inbox/${a.id}/actions/delete`);
    expect(first.statusCode).toBe(428);
    expect(first.json().error).toMatchObject({
      code: 'CONFIRM_REQUIRED',
      confirm: { level: 'important', kind: 'irreversible', consequences: ['删除后无法恢复。'], steps: 2, nextStep: 1, minDelayMs: 3000 },
    });
    let token = '';
    const exec = await confirmOverHttp(app, clock, ownerAuth, (t) => {
      if (t) token = t;
      return post(`/api/inbox/${a.id}/actions/delete`, t ? { confirmToken: t } : undefined);
    });
    expect(exec.json()).toMatchObject({ item: { status: 'done', resolvedAction: 'delete' } });
    expect((await post(`/api/inbox/${a.id}/actions/delete`, { confirmToken: token })).statusCode).toBe(409);

    const b = await seed('b');
    const ch = (await post(`/api/inbox/${b.id}/actions/delete`)).json().error.confirm;
    await post(ch.stepUrl, { step: 1 });
    clock.advance(3000);
    const t2 = (await post(ch.stepUrl, { step: 2 })).json().confirmToken;
    clock.advance(5 * 60 * 1000);
    const late = await post(`/api/inbox/${b.id}/actions/delete`, { confirmToken: t2 });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('CONFIRM_EXPIRED');
  });

  it('第二次点击不满 3 秒：服务端拒绝 425，满 3 秒后可以继续', async () => {
    const a = await seed('a');
    const ch = (await post(`/api/inbox/${a.id}/actions/delete`)).json().error.confirm;
    const s1 = await post(ch.stepUrl, { step: 1 });
    expect(s1.json().confirm).toMatchObject({ nextStep: 2 });
    clock.advance(2999);
    const early = await post(ch.stepUrl, { step: 2 });
    expect(early.statusCode).toBe(425);
    expect(early.json().error).toMatchObject({ code: 'CONFIRM_TOO_EARLY', retryAfterMs: 1 });
    clock.advance(1);
    const ok = await post(ch.stepUrl, { step: 2 });
    expect(ok.statusCode).toBe(200);
    expect(typeof ok.json().confirmToken).toBe('string');
    // 令牌只签发一次
    expect((await post(ch.stepUrl, { step: 2 })).statusCode).toBe(409);
  });

  it('跳过第一步直接点第二步：409', async () => {
    const a = await seed('a');
    const ch = (await post(`/api/inbox/${a.id}/actions/delete`)).json().error.confirm;
    clock.advance(10_000);
    expect((await post(ch.stepUrl, { step: 2 })).json().error.code).toBe('CONFIRM_STEP1_REQUIRED');
  });

  it('操作员（D62）：可以发卡片；不能读收件箱、不能点动作、不能确认；每次拒绝都记审计', async () => {
    const created = await post('/api/inbox', { group: 'decision', kind: 'op-card', title: '请拍板', actions: [{ id: 'ok', label: '好' }] }, opAuth);
    expect(created.statusCode).toBe(201);
    expect(created.json().item).toMatchObject({ title: '请拍板', status: 'open' });
    const a = await seed('a');
    expect((await app.inject({ method: 'GET', url: '/api/inbox', headers: opAuth })).statusCode).toBe(403);
    expect((await post(`/api/inbox/${a.id}/actions/ok`, undefined, opAuth)).statusCode).toBe(403);
    expect((await post(`/api/inbox/${a.id}/actions/delete`, undefined, opAuth)).statusCode).toBe(403);
    expect((await post(`/api/confirm/00000000-0000-0000-0000-000000000000/steps`, { step: 1 }, opAuth)).statusCode).toBe(403);
    // 不存在的接口：同样拒绝并审计（白名单以外的请求一律拒绝）
    expect((await app.inject({ method: 'GET', url: '/api/nope', headers: opAuth })).statusCode).toBe(403);
    const denied = (await deps.auditLog.query({ action: 'auth.denied' })).entries;
    expect(denied).toHaveLength(5);
    expect(denied.every((e) => e.actor.type === 'operator' && e.result === 'denied')).toBe(true);
    expect(denied.map((e) => e.target.id)).toContain('(none)');
  });

  it('发卡片：重要动作必须写后果；主人也能发', async () => {
    const bad = await post('/api/inbox', { group: 'decision', kind: 'x', title: 't', actions: [{ id: 'pay', label: '付', confirm: { kind: 'payment' } }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('CONSEQUENCES_REQUIRED');
    const ok = await post('/api/inbox', { group: 'decision', kind: 'x', title: 't', actions: [{ id: 'pay', label: '付', confirm: { kind: 'payment', consequences: ['扣 ¥1'] } }] });
    expect(ok.statusCode).toBe(201);
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
