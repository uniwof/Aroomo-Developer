import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { LiteLLMAdmin } from '../src/keys/litellm.js';
import { buildServer } from '../src/server.js';
import { PgChallengeStore } from '../src/confirm/confirm.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';
import { MOCK_MASTER_KEY, startMockLiteLLM, type MockLiteLLM } from './helpers/mock-litellm.js';

const DAY = 24 * 60 * 60 * 1000;

describe('定时任务', () => {
  let app: FastifyInstance;
  let deps: CoreDeps;
  let clock: ReturnType<typeof fakeClock>;
  let mock: MockLiteLLM;
  const apps: FastifyInstance[] = [];

  beforeEach(async () => {
    clock = fakeClock();
    deps = memoryDeps(clock.now);
    mock ??= await startMockLiteLLM();
    mock.deployments.clear();
    deps.litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY });
    app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', CORE_JOBS: 'off' }), deps);
    apps.push(app);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await mock?.close();
  });
  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: ownerAuth, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('注册了七个任务', () => {
    expect(app.jobs.names().sort()).toEqual(['confirm-cleanup', 'key-reconcile', 'model-caps', 'recycle-bin', 'takeover-quiet-expiry', 'task-timeout', 'trial-expiry']);
  });

  it('回收站：29 天还在，30 天后彻底删除并写审计', async () => {
    await req('POST', '/api/members', { name: 'Groq' });
    await req('DELETE', '/api/members/groq');
    clock.advance(29 * DAY);
    await app.jobs.runOnce('recycle-bin');
    expect((await req('GET', '/api/members?deleted=true')).json().members).toHaveLength(1);
    clock.advance(1 * DAY + 1000);
    expect(await app.jobs.runOnce('recycle-bin')).toBe('purged=1');
    expect(await deps.members.get('groq')).toBeNull();
    const actions = (await deps.auditLog.query({ limit: 50 })).entries.map((e) => `${e.actor.type}:${e.action}`);
    expect(actions).toContain('system:members.purge_expired');
    expect(actions).toContain('system:job.run');
  });

  it('过期确认：过期超过 1 天才删', async () => {
    await req('POST', '/api/members', { name: 'Groq' });
    await req('DELETE', '/api/members/groq');
    const r = await req('POST', '/api/members/groq/purge');
    expect(r.statusCode).toBe(428);
    const id = r.json().error.confirm.id;
    clock.advance(10 * 60 * 1000);
    await app.jobs.runOnce('confirm-cleanup');
    expect(await deps.confirmChallenges.get(id)).not.toBeNull();
    clock.advance(DAY);
    expect(await app.jobs.runOnce('confirm-cleanup')).toBe('deleted=1');
    expect(await deps.confirmChallenges.get(id)).toBeNull();
  });

  it('Key 对账：LiteLLM 里没了 → 同步失败 + 收件箱卡片（去重）；恢复后变回可用；多余部署只提醒不删', async () => {
    const key = ['placeholder', 'sk', 'rec', 'ABCDEFGHIJKLMNOP'].join('-');
    const k = (await req('POST', '/api/keys', { name: '主号', sourceUrl: 'https://x.example/k', apiKey: key, model: 'openai/gpt-4o-mini' })).json().key;
    expect(await app.jobs.runOnce('key-reconcile')).toBe('');
    const saved = new Map(mock.deployments);
    mock.deployments.clear();
    expect(await app.jobs.runOnce('key-reconcile')).toBe('missing=1');
    await app.jobs.runOnce('key-reconcile');
    expect((await req('GET', '/api/keys')).json().keys[0].status).toBe('sync_failed');
    const cards = (await req('GET', '/api/inbox?group=decision')).json().items;
    expect(cards.filter((c: { kind: string }) => c.kind === 'key-missing')).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toContain(key);
    for (const [id, d] of saved) mock.deployments.set(id, d);
    expect(await app.jobs.runOnce('key-reconcile')).toBe('restored=1');
    expect((await req('GET', '/api/keys')).json().keys[0].status).toBe('active');
    // 多余部署
    mock.deployments.set('aroomo-orphan', { model_name: 'x', litellm_params: { model: 'openai/x', api_key: 'placeholder-x' }, model_info: { id: 'aroomo-orphan' } } as never);
    expect(await app.jobs.runOnce('key-reconcile')).toBe('orphans=1');
    expect(mock.deployments.has('aroomo-orphan')).toBe(true);
    await app.jobs.runOnce('key-reconcile');
    const orphanCards = (await req('GET', '/api/inbox?group=decision')).json().items.filter((c: { kind: string }) => c.kind === 'litellm-orphans');
    expect(orphanCards).toHaveLength(1);
    expect(k.id).toBeTruthy();
  });

  it('LiteLLM 连不上：任务失败只写审计，不抛错', async () => {
    deps.litellm = new LiteLLMAdmin({ baseUrl: 'http://127.0.0.1:1', masterKey: MOCK_MASTER_KEY });
    const a2 = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_JOBS: 'off' }), deps);
    apps.push(a2);
    expect(await a2.jobs.runOnce('key-reconcile')).toBeNull();
    const last = (await deps.auditLog.query({ limit: 5 })).entries.find((e) => e.action === 'job.run');
    expect(last?.result).toBe('failed');
  });
});

describe.each(dbTargets)('ChallengeStore.deleteExpired（$name）', (t) => {
  it('只删过期早于给定时间的', async () => {
    const db = await t.open();
    const s = new PgChallengeStore(db);
    const base = { scope: 's', actor: 'owner', kind: 'irreversible' as const, title: 't', consequences: ['c'], confirmLabel: '确认', payloadSalt: null, payloadDigest: null, requiresReauth: false, step1At: null, tokenHash: null, tokenIssuedAt: null, usedAt: null };
    await s.insert({ ...base, id: '00000000-0000-4000-8000-000000000001', createdAt: new Date('2026-10-01T00:00:00Z'), expiresAt: new Date('2026-10-01T00:05:00Z') });
    await s.insert({ ...base, id: '00000000-0000-4000-8000-000000000002', createdAt: new Date('2026-10-27T00:00:00Z'), expiresAt: new Date('2026-10-27T00:05:00Z') });
    expect(await s.deleteExpired(new Date('2026-10-20T00:00:00Z'))).toBe(1);
    expect(await s.get('00000000-0000-4000-8000-000000000002')).not.toBeNull();
    await db.close();
  });
});
