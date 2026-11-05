/**
 * X-15 聊天里发助手草稿卡（design-assistants-v1 §7.6）：所有者在负责人对话里说「每周一早上 9 点帮我…」，
 * 负责人回一条话 + data-aroomo-assistant-draft 数据块；不调模型、不建助手。点「建好」= 前端拿数据块调 POST /api/assistants。
 * 家人账号、单独和成员的对话、不像要建助手的话：照常对话，不发卡。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/users/password.js';
import { assistantEnv, type AssistantEnv, LEAD } from './helpers/assistants.js';
import { XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD, fakePw, twoAccountEnvs } from './helpers/two-accounts.js';

const CSRF = { 'x-aroomo-request': '1' };
const OWNER_ACCOUNT_ID = '4e000000-0000-4000-8000-00000000a015';
const OWNER_EMAIL = 'owner-draft@example.test';
const OWNER_PW = fakePw(15);
const ASK = '每周一早上 9 点帮我找新的免费模型，筛好告诉我';
type Ev = Record<string, unknown>;

const events = (body: string): Ev[] =>
  body
    .split('\n\n')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('data:') && !e.includes('[DONE]'))
    .map((e) => JSON.parse(e.slice(5)) as Ev);
const draftOf = (body: string) => events(body).find((e) => e.type === 'data-aroomo-assistant-draft') as { id: string; data: Record<string, unknown> } | undefined;
const textOf = (body: string) =>
  events(body)
    .filter((e) => e.type === 'text-delta')
    .map((e) => e.delta)
    .join('');

describe.each(twoAccountEnvs)('X-15 聊天里的助手草稿卡 [$name]', (env) => {
  let e: AssistantEnv;
  let ownerCookie = '';
  let familyCookie = '';
  beforeAll(async () => {
    e = await assistantEnv(env, { extraEnv: { CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID, CORE_CHAT_TOKEN: 'placeholder-chat-token-0123456789abcdefgh' } });
    const at = e.clock.now();
    await e.deps.users.insertUser({ id: OWNER_ACCOUNT_ID, email: OWNER_EMAIL, displayName: '宝宝', role: 'admin', status: 'active', passwordHash: await hashPassword(OWNER_PW), createdAt: at, updatedAt: at });
    const cookie = async (email: string, password: string) => {
      const r = await e.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, cookie: true } });
      expect(r.statusCode, r.body).toBe(200);
      return String(r.headers['set-cookie']).split(';')[0]!;
    };
    ownerCookie = await cookie(OWNER_EMAIL, OWNER_PW);
    familyCookie = await cookie(XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD);
    expect((await e.xiao('POST', '/api/members', { name: 'XiaoBot' })).statusCode).toBeLessThan(300);
    // 让组长成员能当负责人（真环境由 LiteLLM 的模型信息填）
    const lead = (await e.deps.members.get(LEAD.id))!;
    await e.deps.members.update({ ...lead, modelCaps: { mode: 'chat', maxInputTokens: 128000, supportsTools: true, checkedAt: e.clock.now().toISOString() } });
  });
  afterAll(async () => {
    await e.closeAll();
  });

  const say = (cookie: string, content: string, model = 'aroomo') =>
    e.app.inject({ method: 'POST', url: '/api/chat/stream', headers: { cookie, ...CSRF }, payload: { model, messages: [{ role: 'user', content }] } });
  const count = async () => (await e.owner('GET', '/api/assistants')).json().assistants.length as number;

  it('所有者说「每周一早上 9 点帮我…」：负责人回草稿卡（署名负责人），不调模型，不建助手；点「建好」才建', async () => {
    const before = await count();
    e.gw.calls.length = 0;
    const r = await say(ownerCookie, ASK);
    expect(r.statusCode).toBe(200);
    expect(e.gw.calls).toEqual([]);
    expect(textOf(r.body)).toMatch(/点「建好」才会真的建/);
    expect(textOf(r.body)).toMatch(/— .+（负责人）$/);
    const d = draftOf(r.body)!;
    expect(d.id).toMatch(/^draft_/);
    expect(d.data).toMatchObject({
      name: '找新的免费模型',
      instructions: '找新的免费模型，筛好告诉我',
      schedule: { kind: 'weekly', time: '09:00', days: [1] },
      budgetLevel: 'low',
      scheduleText: '每周一 09:00',
    });
    expect(d.data.members).toEqual([d.data.leadMemberId]);
    expect(typeof d.data.nextRunAt).toBe('string');
    // 只发了卡，没建
    expect(await count()).toBe(before);
    // 「建好」：前端拿卡上的数据调 POST /api/assistants（带幂等键，连点两次只建一个）
    const { name, instructions, members, leadMemberId, schedule, timezone, budgetLevel } = d.data;
    const body = { name, instructions, members, leadMemberId, schedule, timezone, budgetLevel };
    const key = { 'idempotency-key': d.id };
    const c1 = await e.app.inject({ method: 'POST', url: '/api/assistants', headers: { cookie: ownerCookie, ...CSRF, ...key }, payload: body });
    expect(c1.statusCode, c1.body).toBe(201);
    const c2 = await e.app.inject({ method: 'POST', url: '/api/assistants', headers: { cookie: ownerCookie, ...CSRF, ...key }, payload: body });
    expect(c2.statusCode).toBe(200);
    expect(c2.json().assistant.id).toBe(c1.json().assistant.id);
    expect(await count()).toBe(before + 1);
  });

  it('不像要建助手的话、单独和成员的对话：照常对话，不发卡', async () => {
    e.gw.calls.length = 0;
    const plain = await say(ownerCookie, '帮我找新的免费模型');
    expect(draftOf(plain.body)).toBeUndefined();
    const single = await say(ownerCookie, ASK, `aroomo/${LEAD.id}`);
    expect(draftOf(single.body)).toBeUndefined();
    expect(e.gw.calls.length).toBe(2);
  });

  it('家人账号说同样的话：不发卡（家人第一版不能建助手），照常走自己的对话路由', async () => {
    e.gw.calls.length = 0;
    const r = await say(familyCookie, ASK);
    expect(r.statusCode).toBe(200);
    expect(draftOf(r.body)).toBeUndefined();
    // 走的是家人自己的对话路由（这里家人还没有合格的负责人，就是那句提示），不是草稿卡
    expect(textOf(r.body)).not.toMatch(/建好/);
    expect(textOf(r.body)).toMatch(/负责人/);
  });
});
