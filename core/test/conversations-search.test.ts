/**
 * X-09 会话搜索 GET /api/search（docs/api/design-search-compaction-v1.md §1）+ X-21 复核：聊天生成中途换新进程。
 * memory + PGlite（+ CI 真 PG）。所有者账号和家人账号各搜各的；归档的、助手会话、摘要灰字不在结果里。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { snippet } from '../src/conversations/service.js';
import { hashPassword } from '../src/users/password.js';
import { assistantEnv, type AssistantEnv, LEAD } from './helpers/assistants.js';
import { OWNER_TOKEN, ownerAuth } from './helpers/db.js';
import { XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD, fakePw, twoAccountEnvs } from './helpers/two-accounts.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const OWNER_ACCOUNT_ID = '4e000000-0000-4000-8000-00000000c009';
const uuid = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

describe.each(twoAccountEnvs)('会话搜索 /api/search [$name]', (env) => {
  let e: AssistantEnv;
  let ownerCookie = '';
  let familyCookie = '';
  beforeAll(async () => {
    e = await assistantEnv(env, { extraEnv: { CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID, CORE_CHAT_TOKEN: 'placeholder-chat-token-0123456789abcdefgh' } });
    const at = e.clock.now();
    const pw = fakePw(9);
    await e.deps.users.insertUser({ id: OWNER_ACCOUNT_ID, email: 'owner-x09@example.test', displayName: '宝宝', role: 'admin', status: 'active', passwordHash: await hashPassword(pw), createdAt: at, updatedAt: at });
    const login = async (email: string, password: string) => String((await e.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, cookie: true } })).headers['set-cookie']).split(';')[0]!;
    ownerCookie = await login('owner-x09@example.test', pw);
    familyCookie = await login(XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD);
    expect((await e.xiao('POST', '/api/members', { name: 'XiaoBot' })).statusCode).toBeLessThan(300);
    const lead = (await e.deps.members.get(LEAD.id))!;
    await e.deps.members.update({ ...lead, modelCaps: { mode: 'chat', maxInputTokens: 128000, supportsTools: true, checkedAt: at.toISOString() } });
  });
  afterAll(async () => e.closeAll());

  const as = (cookie: string) => (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    e.app.inject({ method, url, headers: { cookie, 'x-aroomo-request': '1' }, ...(payload ? { payload } : {}) });
  const owner = () => as(ownerCookie);
  const family = () => as(familyCookie);
  const search = async (cookie: string, q: string, extra = '') => {
    const r = await as(cookie)('GET', `/api/search?q=${encodeURIComponent(q)}${extra}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { results: Json[]; nextBeforeSeq: number | null };
  };
  const say = async (cookie: string, id: string, content: string) => {
    e.clock.advance(1000);
    expect((await as(cookie)('POST', '/api/chat/stream', { conversationId: id, messages: [{ role: 'user', content }] })).statusCode).toBe(200);
  };

  it('搜到用户话和回复：会话标题、消息 id、片段；最近的在前；不分大小写；% 和 _ 按字面', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(1), title: '周末计划' });
    await say(ownerCookie, uuid(1), '周末想去杭州西湖看看');
    await owner()('POST', '/api/conversations', { id: uuid(2), title: '工作' });
    await say(ownerCookie, uuid(2), '下周去杭州出差，订 Hotel 100% 可退的');
    const r = await search(ownerCookie, '杭州');
    expect(r.results.map((x) => x.conversationId)).toEqual([uuid(2), uuid(1)]);
    expect(r.results[0]).toMatchObject({ title: '工作', role: 'user', snippet: '下周去杭州出差，订 Hotel 100% 可退的' });
    const msgs = (await owner()('GET', `/api/conversations/${uuid(2)}/messages`)).json().messages as Json[];
    expect(r.results[0]!.messageId).toBe(msgs[0]!.id);
    expect(r.results[0]!.seq).toBe(msgs[0]!.seq);
    expect((await search(ownerCookie, 'hotel')).results).toHaveLength(1);
    expect((await search(ownerCookie, '100%')).results).toHaveLength(1);
    expect((await search(ownerCookie, '0%可')).results).toHaveLength(0); // % 不是通配
    expect((await search(ownerCookie, '杭_')).results).toHaveLength(0); // _ 不是通配
    // 回复也能搜（假网关回「结果-<模型>」）
    expect((await search(ownerCookie, `结果-${LEAD.name}`)).results.every((x) => x.role === 'assistant')).toBe(true);
  });

  it('翻页：limit + nextBeforeSeq，不重复；空搜索词 400', async () => {
    const p1 = await search(ownerCookie, '杭州', '&limit=1');
    expect(p1.results).toHaveLength(1);
    expect(p1.nextBeforeSeq).toBe(p1.results[0]!.seq);
    const p2 = await search(ownerCookie, '杭州', `&limit=1&beforeSeq=${p1.nextBeforeSeq}`);
    expect(p2.results.map((x) => x.conversationId)).toEqual([uuid(1)]);
    expect(p2.nextBeforeSeq).toBeNull();
    expect((await owner()('GET', '/api/search?q=%20%20')).statusCode).toBe(400);
    expect((await owner()('GET', '/api/search')).statusCode).toBe(400);
    expect((await owner()('GET', `/api/search?q=${'a'.repeat(101)}`)).statusCode).toBe(400);
  });

  it('X-23：家人搜不到所有者的话，所有者也搜不到家人的；请求里带 userId 400；没登录 401', async () => {
    expect((await search(familyCookie, '杭州')).results).toEqual([]);
    const c = await family()('POST', '/api/conversations', { title: '家人的' });
    await say(familyCookie, c.json().conversation.id, '家人也想去杭州');
    expect((await search(familyCookie, '杭州')).results.map((x) => x.snippet)).toEqual(['家人也想去杭州']);
    expect((await search(ownerCookie, '家人也想')).results).toEqual([]);
    expect((await owner()('GET', '/api/search?q=x&userId=owner')).statusCode).toBe(400);
    expect((await e.app.inject({ method: 'GET', url: '/api/search?q=x' })).statusCode).toBe(401);
    // 所有者令牌（Bearer）和所有者账号是同一份数据
    expect((await e.owner('GET', `/api/search?q=${encodeURIComponent('西湖')}`)).json().results).toHaveLength(1);
  });

  it('归档的会话、助手的固定会话不在结果里', async () => {
    await owner()('PATCH', `/api/conversations/${uuid(1)}`, { archived: true });
    expect((await search(ownerCookie, '西湖')).results).toEqual([]);
    await owner()('PATCH', `/api/conversations/${uuid(1)}`, { archived: false });
    expect((await search(ownerCookie, '西湖')).results).toHaveLength(1);
    const aid = await e.create({ name: '找资料', members: [LEAD.id] });
    expect((await e.owner('POST', `/api/assistants/${aid}/runs`)).statusCode).toBeLessThan(300);
    await e.app.assistants.runner.idle();
    expect((await search(ownerCookie, `结果-${LEAD.name}`)).results.every((x) => [uuid(1), uuid(2)].includes(x.conversationId))).toBe(true);
  });

  it('X-21：聊天生成到一半换新进程 → 会话不再是「进行中」，用户的话还在', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(9), title: '重启' });
    let open!: () => void;
    e.gw.calls.length = 0;
    e.gw.gate = new Promise<void>((r) => (open = r));
    const pending = owner()('POST', '/api/chat/stream', { conversationId: uuid(9), messages: [{ role: 'user', content: '重启前说的话' }] });
    for (let i = 0; i < 50 && !e.gw.calls.includes(LEAD.name); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await owner()('GET', `/api/conversations/${uuid(9)}`)).json().conversation.running).toBe(true);
    const app2 = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), e.deps);
    await app2.ready();
    const get = async (u: string) => (await app2.inject({ method: 'GET', url: u, headers: ownerAuth })).json() as Json;
    expect((await get(`/api/conversations/${uuid(9)}`)).conversation.running).toBe(false);
    expect((await get('/api/conversations?filter=running')).conversations).toEqual([]);
    expect((await get(`/api/conversations/${uuid(9)}/messages`)).messages.map((m: Json) => [m.role, m.content])).toEqual([['user', '重启前说的话']]);
    e.gw.gate = null;
    open();
    await pending;
  });
});

describe('snippet', () => {
  it('命中处前 30 字、后 60 字，两头截断加「…」，换行压成空格', () => {
    expect(snippet('短的\n一句', '一句')).toBe('短的 一句');
    const s = snippet(`${'前'.repeat(50)}关键${'后'.repeat(100)}`, '关键');
    expect(s).toBe(`…${'前'.repeat(30)}关键${'后'.repeat(60)}…`);
  });
});
