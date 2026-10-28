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

  let clock: ReturnType<typeof fakeClock>;
  beforeEach(async () => {
    clock = fakeClock();
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

  const k = (t: string) => ['placeholder', 'sk', t, 'ABCDEFGHIJKLMNOP'].join('-');
  const addKey = async (model: string, modelName: string) => {
    const r = await req('POST', '/api/keys', { name: modelName, sourceUrl: 'https://x.example/k', apiKey: k(modelName.replace(/\W/g, '')), model, modelName });
    expect(r.statusCode).toBe(201);
    return r.json().key.id as string;
  };
  const memberByName = async (name: string) =>
    (await req('GET', '/api/members')).json().members.find((m: { name: string }) => m.name === name);
  const hire = async (model: string, modelName: string) => {
    await addKey(model, modelName);
    const m = await memberByName(modelName);
    const r = await req('POST', `/api/members/${m.id}/onboard`);
    expect(r.statusCode).toBe(200);
    return r.json().member;
  };

  it('没有成员时没有负责人；有合格成员后自动用第一个合格的（置顶优先）', async () => {
    expect((await req('GET', '/api/settings/lead')).json()).toEqual({ leadId: null, effectiveLeadId: null, auto: true });
    await hire('openai/gpt-4o-mini', 'Groq');
    await hire('openai/gpt-4o-mini', 'Gemini 2.5 Pro');
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('groq');
    await req('PUT', '/api/members/gemini-2-5-pro/pin');
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('gemini-2-5-pro');
  });

  it('选定负责人；停用 / 不存在 / 不合格的成员不能选；选的人被停用后自动兜底', async () => {
    await hire('openai/gpt-4o-mini', 'Groq');
    await hire('openai/gpt-4o-mini', 'Claude');
    await hire('openai/small-ctx', 'Tiny');
    expect((await req('PUT', '/api/settings/lead', { leadId: 'claude' })).json()).toEqual({ leadId: 'claude', effectiveLeadId: 'claude', auto: false });
    expect((await req('PUT', '/api/settings/lead', { leadId: 'nobody' })).json().error.code).toBe('MEMBER_NOT_FOUND');
    const bad = (await req('PUT', '/api/settings/lead', { leadId: 'tiny' })).json().error;
    expect(bad.code).toBe('LEAD_NOT_ELIGIBLE');
    expect(bad.message).toContain('上下文不到 32k');
    await req('PATCH', '/api/members/claude', { enabled: false });
    expect((await req('GET', '/api/settings/lead')).json()).toEqual({ leadId: 'claude', effectiveLeadId: 'groq', auto: true });
    expect((await req('PUT', '/api/settings/lead', { leadId: 'claude' })).json().error.code).toBe('MEMBER_DISABLED');
    expect((await req('PUT', '/api/settings/lead', { leadId: null })).statusCode).toBe(200);
  });

  it('负责人资格（§9.1）：能文字对话、上下文 ≥32k、支持工具调用；专用模型 / 未知能力不合格', async () => {
    await hire('openai/gpt-4o-mini', 'Good');
    await hire('openai/small-ctx', 'Tiny');
    await hire('openai/no-tools', 'NoTools');
    await hire('openai/dall-e-3', 'Painter');
    await hire('openai/unknown-model', 'Mystery');
    await req('POST', '/api/members', { name: 'Manual' });
    const ms = (await req('GET', '/api/members')).json().members as Array<{ name: string; leadEligible: boolean; leadIneligibleReason: string | null; modelCaps: unknown }>;
    const by = (n: string) => ms.find((m) => m.name === n)!;
    expect(by('Good')).toMatchObject({ leadEligible: true, leadIneligibleReason: null, modelCaps: { mode: 'chat', maxInputTokens: 128000, supportsTools: true } });
    expect(by('Tiny').leadIneligibleReason).toContain('上下文不到 32k');
    expect(by('NoTools').leadIneligibleReason).toBe('不支持工具调用');
    expect(by('Painter').leadIneligibleReason).toContain('专用模型');
    expect(by('Mystery').leadIneligibleReason).toContain('不确定');
    expect(by('Manual').leadIneligibleReason).toBe('还没有拿到这个模型的能力信息');
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('good');
  });

  it('入职流程（§9.1）：新增 Key → 模型进候选 + 收件箱卡片；候选不能当负责人；一键入职后成为负责人', async () => {
    await addKey('openai/gpt-4o-mini', 'GPT-4o mini');
    const cand = await memberByName('GPT-4o mini');
    expect(cand).toMatchObject({ status: 'candidate', leadEligible: false });
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBeNull();
    const inbox = (await req('GET', '/api/inbox?status=open')).json();
    const card = inbox.groups.candidate.find((i: { related?: { id: string } }) => i.related?.id === cand.id);
    expect(card.title).toBe('新成员候选：GPT-4o mini');
    expect(card.summary).toContain('上下文 128k');
    expect(card.actions.map((a: { id: string }) => a.id)).toEqual(['onboard', 'reject']);
    // 收件箱一键入职
    const r = await req('POST', `/api/inbox/${card.id}/actions/onboard`, {});
    expect(r.statusCode).toBe(200);
    expect((await memberByName('GPT-4o mini')).status).toBe('active');
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe(cand.id);
    // 同一个模型再加一个 Key：不重复建成员、不重复发卡片
    await addKey('openai/gpt-4o-mini', 'gpt-4o MINI');
    expect((await req('GET', '/api/members')).json().members).toHaveLength(1);
    expect((await req('GET', '/api/inbox?status=open')).json().groups.candidate ?? []).toHaveLength(0);
  });

  it('成员页「入职」同时处理收件箱卡片；收件箱「不要」把候选移到回收站', async () => {
    await addKey('openai/gpt-4o-mini', 'Alpha');
    await addKey('openai/gpt-4o-mini', 'Beta');
    const alpha = await memberByName('Alpha');
    expect((await req('POST', `/api/members/${alpha.id}/onboard`)).json().member.status).toBe('active');
    const open = (await req('GET', '/api/inbox?status=open')).json().groups.candidate as Array<{ id: string; related: { id: string } }>;
    expect(open.map((i) => i.related.id)).toEqual(['beta']);
    expect((await req('POST', `/api/inbox/${open[0]!.id}/actions/reject`, {})).statusCode).toBe(200);
    expect(await memberByName('Beta')).toBeUndefined();
    const bin = (await req('GET', '/api/members?deleted=true')).json().members;
    expect(bin.map((m: { name: string }) => m.name)).toEqual(['Beta']);
  });

  it('删掉某个模型的最后一个 Key → 对应成员自动停用，负责人换成别人', async () => {
    const a = await addKey('openai/gpt-4o-mini', 'Model A');
    await req('POST', '/api/members/model-a/onboard');
    await hire('openai/gpt-4o-mini', 'Model B');
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('model-a');
    // 删除是重要确认（本地版 reauth=off：两步 + 3 秒）
    const first = await app.inject({ method: 'DELETE', url: `/api/keys/${a}`, headers: ownerAuth });
    expect(first.statusCode).toBe(428);
    const ch = first.json().error.confirm;
    await app.inject({ method: 'POST', url: ch.stepUrl, headers: ownerAuth, payload: { step: 1 } });
    clock.advance(3000);
    const tok = (await app.inject({ method: 'POST', url: ch.stepUrl, headers: ownerAuth, payload: { step: 2 } })).json().confirmToken;
    expect((await app.inject({ method: 'DELETE', url: `/api/keys/${a}`, headers: ownerAuth, payload: { confirmToken: tok } })).statusCode).toBe(204);
    const ms = (await req('GET', '/api/members')).json().members;
    expect(ms.find((m: { id: string }) => m.id === 'model-a').enabled).toBe(false);
    expect((await req('GET', '/api/settings/lead')).json().effectiveLeadId).toBe('model-b');
  });

  it('敏感内容保护开关（D38）：默认开；主人可以关、开；写审计', async () => {
    expect((await req('GET', '/api/settings/security')).json()).toEqual({ sensitiveProtect: true });
    expect((await req('PUT', '/api/settings/security', { sensitiveProtect: false })).json()).toEqual({ sensitiveProtect: false });
    expect((await req('GET', '/api/settings/security')).json()).toEqual({ sensitiveProtect: false });
    expect((await req('PUT', '/api/settings/security', { sensitiveProtect: 'no' })).statusCode).toBe(400);
    const audit = (await req('GET', '/api/audit?limit=50')).json().entries.map((e: { action: string; detail?: string }) => e.action);
    expect(audit).toContain('settings.sensitive_protect');
    await req('PUT', '/api/settings/security', { sensitiveProtect: true });
    expect((await req('GET', '/api/settings/security')).json()).toEqual({ sensitiveProtect: true });
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
