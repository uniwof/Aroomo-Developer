import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { PgSettingsStore } from '../src/settings/store.js';
import { LiteLLMAdmin } from '../src/keys/litellm.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';
import { MOCK_MASTER_KEY, startMockLiteLLM, type MockLiteLLM } from './helpers/mock-litellm.js';

describe('/api/settings/lead（负责人）', () => {
  let app: FastifyInstance;
  let deps: CoreDeps;
  let mock: MockLiteLLM;
  const apps: FastifyInstance[] = [];

  beforeEach(async () => {
    const clock = fakeClock();
    deps = memoryDeps(clock.now);
    mock ??= await startMockLiteLLM();
    mock.deployments.clear();
    deps.litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY });
    app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
    apps.push(app);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await mock?.close();
  });
  const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: ownerAuth, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('没有成员时没有负责人；有成员后自动用第一个启用的（置顶优先）', async () => {
    expect((await req('GET', '/api/settings/lead')).json()).toEqual({ leadId: null, effectiveLeadId: null, auto: true });
    await req('POST', '/api/members', { name: 'Groq' });
    await req('POST', '/api/members', { name: 'Gemini 2.5 Pro' });
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('groq');
    await req('PUT', '/api/members/gemini-2-5-pro/pin');
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('gemini-2-5-pro');
  });

  it('选定负责人；停用 / 不存在的成员不能选；选的人被停用后自动兜底', async () => {
    await req('POST', '/api/members', { name: 'Groq' });
    await req('POST', '/api/members', { name: 'Claude' });
    expect((await req('PUT', '/api/settings/lead', { leadId: 'claude' })).json()).toEqual({ leadId: 'claude', effectiveLeadId: 'claude', auto: false });
    expect((await req('PUT', '/api/settings/lead', { leadId: 'nobody' })).json().error.code).toBe('MEMBER_NOT_FOUND');
    await req('PATCH', '/api/members/claude', { enabled: false });
    expect((await req('GET', '/api/settings/lead')).json()).toEqual({ leadId: 'claude', effectiveLeadId: 'groq', auto: true });
    expect((await req('PUT', '/api/settings/lead', { leadId: 'claude' })).json().error.code).toBe('MEMBER_DISABLED');
    expect((await req('PUT', '/api/settings/lead', { leadId: null })).statusCode).toBe(200);
  });

  it('新增 Key 后，这个模型自动成为成员并成为负责人（填入一个 Key 就能对话）', async () => {
    const key = ['placeholder', 'sk', 'lead', 'ABCDEFGHIJKLMNOP'].join('-');
    const r = await req('POST', '/api/keys', { name: '测试', sourceUrl: 'https://x.example/k', apiKey: key, model: 'openai/gpt-4o-mini', modelName: 'GPT-4o mini' });
    expect(r.statusCode).toBe(201);
    const members = (await req('GET', '/api/members')).json().members;
    expect(members.map((m: { name: string }) => m.name)).toEqual(['GPT-4o mini']);
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe(members[0].id);
    // 同一个模型再加一个 Key：不重复建成员
    await req('POST', '/api/keys', { name: '备用', sourceUrl: 'https://x.example/k', apiKey: key + 'X', model: 'openai/gpt-4o-mini', modelName: 'gpt-4o MINI' });
    expect((await req('GET', '/api/members')).json().members).toHaveLength(1);
  });
});

describe.each(dbTargets)('SettingsStore（$name）', (t) => {
  it('读写、覆盖', async () => {
    const db = await t.open();
    const s = new PgSettingsStore(db);
    expect(await s.get('lead')).toBeNull();
    await s.set('lead', { memberId: 'a' }, new Date());
    await s.set('lead', { memberId: 'b' }, new Date());
    expect(await s.get('lead')).toEqual({ memberId: 'b' });
    await db.close();
  });
});
