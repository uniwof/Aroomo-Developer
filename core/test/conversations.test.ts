/**
 * 会话存库（#250 integrate/stage2；F-036 / X-21 / X-27 / X-23）：/api/conversations + /api/chat/stream 落库。
 * 所有者账号（方案 A，scope = owner）和家人账号（小号）各管各的：别人的会话和不存在的一样；消息只追加；只归档不删除。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/users/password.js';
import { MemoryConversationStore } from '../src/conversations/memory.js';
import { ConversationService } from '../src/conversations/service.js';
import { assistantEnv, type AssistantEnv, LEAD, WORKER } from './helpers/assistants.js';
import type { CoreDeps } from '../src/deps.js';
import { XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD, expectSameAsMissing, fakePw, twoAccountEnvs } from './helpers/two-accounts.js';

const CSRF = { 'x-aroomo-request': '1' };
const OWNER_ACCOUNT_ID = '4e000000-0000-4000-8000-00000000c025';
const OWNER_EMAIL = 'owner-conv@example.test';
const OWNER_PW = fakePw(25);
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const T_UPD = Date.UTC(2026, 9, 20, 2, 0);
const T_MSG = Date.UTC(2026, 9, 20, 1, 59);
const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.each(twoAccountEnvs)('会话存库 /api/conversations [$name]', (env) => {
  let e: AssistantEnv;
  let ownerCookie = '';
  let familyCookie = '';
  beforeAll(async () => {
    // 所有者账号要在服务启动前就在库里：#268 的启动检查（onReady）认过它，Cookie 会话才映射到所有者数据
    const seed = async (deps: CoreDeps, now: () => Date) => {
      const at = now();
      await deps.users.insertUser({ id: OWNER_ACCOUNT_ID, email: OWNER_EMAIL, displayName: '宝宝', role: 'admin', status: 'active', passwordHash: await hashPassword(OWNER_PW), createdAt: at, updatedAt: at });
    };
    e = await assistantEnv(env, { seed, extraEnv: { CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID, CORE_CHAT_TOKEN: 'placeholder-chat-token-0123456789abcdefgh' } });
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

  const as = (cookie: string) => (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    e.app.inject({ method, url, headers: { cookie, ...CSRF }, ...(payload ? { payload } : {}) });
  const owner = () => as(ownerCookie);
  const family = () => as(familyCookie);
  const say = (cookie: string, payload: Json) => e.app.inject({ method: 'POST', url: '/api/chat/stream', headers: { cookie, ...CSRF }, payload });
  const msgs = async (cookie: string, id: string, q = '') => (await as(cookie)('GET', `/api/conversations/${id}/messages${q}`)).json() as Json;

  it('建会话 → 发一句 → 用户的话和回复都落库（只追加，seq 递增）；列表带预览、条数；回复算未读，标已读后不算', async () => {
    const c = await owner()('POST', '/api/conversations', { id: uuid(1), title: '  周末   去哪 ', model: 'aroomo' });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().conversation).toMatchObject({ id: uuid(1), title: '周末 去哪', model: 'aroomo', group: [], archived: false, unread: false, running: false, messageCount: 0 });
    // 同一个 id 再建：原样返回，不重复
    const again = await owner()('POST', '/api/conversations', { id: uuid(1), title: '别的名字' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, conversation: { title: '周末 去哪' } });

    e.clock.advance(1000);
    const r = await say(ownerCookie, { conversationId: uuid(1), messages: [{ role: 'user', content: '周末去哪玩' }] });
    expect(r.statusCode).toBe(200);
    const m = await msgs(ownerCookie, uuid(1));
    expect(m.messages.map((x: Json) => x.role)).toEqual(['user', 'assistant']);
    expect(m.messages[0].content).toBe('周末去哪玩');
    // 存的就是浏览器收到的整段回复（含署名）
    expect(m.messages[1].content).toBe(r.body.split('\n\n').map((x) => x.trim()).filter((x) => x.includes('text-delta')).map((x) => (JSON.parse(x.slice(5)) as Json).delta).join(''));
    expect(m.messages[1].content).toMatch(/（负责人）$/);
    // 裁定 16：回复记下是哪位成员答的（Core 选的负责人：id + 名字快照）；用户的话没有
    expect(m.messages[1].answeredBy).toEqual([{ memberId: LEAD.id, name: LEAD.name }]);
    expect(m.messages[0].answeredBy).toBeUndefined();
    expect(m.messages[1].seq).toBeGreaterThan(m.messages[0].seq);
    expect(m.hasMore).toBe(false);

    const list = (await owner()('GET', '/api/conversations')).json();
    const row = list.conversations.find((x: Json) => x.id === uuid(1));
    expect(row).toMatchObject({ unread: true, messageCount: 2, last: { role: 'assistant' } });
    expect((await owner()('GET', '/api/conversations?filter=unread')).json().conversations.map((x: Json) => x.id)).toContain(uuid(1));
    e.clock.advance(1000);
    expect((await owner()('POST', `/api/conversations/${uuid(1)}/read`)).statusCode).toBe(204);
    expect((await owner()('GET', `/api/conversations/${uuid(1)}`)).json().conversation.unread).toBe(false);
    expect((await owner()('GET', '/api/conversations?filter=unread')).json().conversations.map((x: Json) => x.id)).not.toContain(uuid(1));
    // 没有在生成的会话：「进行中」为空
    expect((await owner()('GET', '/api/conversations?filter=running')).json().conversations).toEqual([]);
  });

  it('重试（retry: true）只追加新回复，不重复追加用户的话；不带 conversationId 不落库', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(2) });
    await say(ownerCookie, { conversationId: uuid(2), messages: [{ role: 'user', content: '第一句' }] });
    await say(ownerCookie, { conversationId: uuid(2), retry: true, messages: [{ role: 'user', content: '第一句' }] });
    expect((await msgs(ownerCookie, uuid(2))).messages.map((x: Json) => x.role)).toEqual(['user', 'assistant', 'assistant']);
    await say(ownerCookie, { messages: [{ role: 'user', content: '不存' }] });
    expect((await msgs(ownerCookie, uuid(2))).messages).toHaveLength(3);
  });

  it('裁定 16：@ 点名一位成员时，存下的回复记的是被点名的那位（id + 名字）', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(91) });
    const r = await say(ownerCookie, { conversationId: uuid(91), messages: [{ role: 'user', content: `@${WORKER.name} 你好` }] });
    expect(r.statusCode).toBe(200);
    const m = await msgs(ownerCookie, uuid(91));
    expect(m.messages.map((x: Json) => x.role)).toEqual(['user', 'assistant']);
    expect(m.messages[1].answeredBy).toEqual([{ memberId: WORKER.id, name: WORKER.name }]);
  });

  it('审计 C9：群聊会话存的成员名单生效：没 @ 只交给群里的人；@ 群外的人只给一行提示、不调它；不存会话时认请求体的 group', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(92), model: 'aroomo', group: [WORKER.name] });
    e.gw.calls.length = 0;
    const r = await say(ownerCookie, { conversationId: uuid(92), messages: [{ role: 'user', content: '大家好' }] });
    expect(r.statusCode).toBe(200);
    expect(e.gw.calls).toEqual([WORKER.name]);
    expect((await msgs(ownerCookie, uuid(92))).messages[1].answeredBy).toEqual([{ memberId: WORKER.id, name: WORKER.name }]);
    e.gw.calls.length = 0;
    const out = await say(ownerCookie, { conversationId: uuid(92), messages: [{ role: 'user', content: `@${LEAD.name} 你在吗` }] });
    expect(out.body).toContain(`${LEAD.name} 不在这个群里`);
    expect(e.gw.calls).toEqual([]);
    // 请求体里的 group 在有会话时不看（以库里的为准）
    e.gw.calls.length = 0;
    await say(ownerCookie, { conversationId: uuid(92), group: [LEAD.name], messages: [{ role: 'user', content: '再说一次' }] });
    expect(e.gw.calls).toEqual([WORKER.name]);
    e.gw.calls.length = 0;
    await say(ownerCookie, { group: [WORKER.name], messages: [{ role: 'user', content: '不存会话' }] });
    expect(e.gw.calls).toEqual([WORKER.name]);
  });

  it('X-15 草稿卡也落库：回复带 draft（id = 流里那张卡的 id），刷新后还能渲染', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(3) });
    const r = await say(ownerCookie, { conversationId: uuid(3), model: 'aroomo', messages: [{ role: 'user', content: '每周一早上 9 点帮我找新的免费模型，筛好告诉我' }] });
    const card = r.body.split('\n\n').map((x) => x.trim()).filter((x) => x.includes('data-aroomo-assistant-draft')).map((x) => JSON.parse(x.slice(5)) as Json)[0]!;
    const saved = (await msgs(ownerCookie, uuid(3))).messages[1];
    expect(saved.draft.id).toBe(card.id);
    expect(saved.draft.data).toEqual(card.data);
  });

  it('改名、归档（不删除）：归档后默认列表里没有，archived=true 里有；能取消归档；没有 DELETE', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(4), title: '旧名' });
    expect((await owner()('PATCH', `/api/conversations/${uuid(4)}`, { title: '  新名 ' })).json().conversation.title).toBe('新名');
    expect((await owner()('PATCH', `/api/conversations/${uuid(4)}`, { title: '   ' })).statusCode).toBe(400);
    expect((await owner()('PATCH', `/api/conversations/${uuid(4)}`, { archived: true })).json().conversation.archived).toBe(true);
    expect((await owner()('GET', '/api/conversations')).json().conversations.map((x: Json) => x.id)).not.toContain(uuid(4));
    expect((await owner()('GET', '/api/conversations?archived=true')).json().conversations.map((x: Json) => x.id)).toEqual([uuid(4)]);
    expect((await owner()('PATCH', `/api/conversations/${uuid(4)}`, { archived: false })).json().conversation.archived).toBe(false);
    const del = await e.app.inject({ method: 'DELETE', url: `/api/conversations/${uuid(4)}`, headers: { cookie: ownerCookie, ...CSRF } });
    expect([403, 404]).toContain(del.statusCode);
  });

  it('列表分页（游标）：每页 2 条，按最近更新排，翻完 nextCursor 为空、不重复', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Json = (await owner()('GET', `/api/conversations?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      expect(page.conversations.length).toBeLessThanOrEqual(2);
      seen.push(...page.conversations.map((x: Json) => x.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect((await owner()('GET', '/api/conversations?cursor=bm9wZQ')).statusCode).toBe(400);
  });

  it('消息分页（按 seq）：默认取最近的，beforeSeq 往前、afterSeq 往后', async () => {
    await owner()('POST', '/api/conversations', { id: uuid(5) });
    for (const t of ['一', '二', '三']) await say(ownerCookie, { conversationId: uuid(5), messages: [{ role: 'user', content: t }] });
    const latest = await msgs(ownerCookie, uuid(5), '?limit=2');
    expect(latest.hasMore).toBe(true);
    expect(latest.messages.map((x: Json) => x.content)[0]).toBe('三');
    const older = await msgs(ownerCookie, uuid(5), `?limit=10&beforeSeq=${latest.messages[0].seq}`);
    expect(older.messages.map((x: Json) => x.content).slice(0, 1)).toEqual(['一']);
    expect(older.messages).toHaveLength(4);
    const after = await msgs(ownerCookie, uuid(5), `?limit=2&afterSeq=${older.messages[0].seq}`);
    expect(after.messages.map((x: Json) => x.seq)).toEqual(older.messages.slice(1, 3).map((x: Json) => x.seq));
    expect(after.hasMore).toBe(true);
    // 阶段 2 预审：两个方向同时给 → 400（以前 beforeSeq 被悄悄忽略）
    expect((await owner()('GET', `/api/conversations/${uuid(5)}/messages?afterSeq=1&beforeSeq=9`)).statusCode).toBe(400);
  });

  it('X-23 跨账号：家人看不到、改不了、写不进所有者的会话（和不存在的一样）；列表各管各的', async () => {
    const probes: Array<(id: string) => Promise<Awaited<ReturnType<ReturnType<typeof family>>>>> = [
      (id) => family()('GET', `/api/conversations/${id}`),
      (id) => family()('GET', `/api/conversations/${id}/messages`),
      (id) => family()('PATCH', `/api/conversations/${id}`, { title: '偷改' }),
      (id) => family()('PATCH', `/api/conversations/${id}`, { archived: true }),
      (id) => family()('POST', `/api/conversations/${id}/read`),
      (id) => say(familyCookie, { conversationId: id, messages: [{ role: 'user', content: '写进去' }] }),
    ];
    for (const p of probes) await expectSameAsMissing(p, uuid(1), MISSING);
    expect((await family()('GET', '/api/conversations')).json().conversations).toEqual([]);
    expect((await msgs(ownerCookie, uuid(1))).messages).toHaveLength(2);
    expect((await owner()('GET', `/api/conversations/${uuid(1)}`)).json().conversation.title).toBe('周末 去哪');

    // 家人拿所有者的会话 id 建会话：换一个新 id，不回 409（看不出那个 id 存在），也碰不到所有者那条
    const c = await family()('POST', '/api/conversations', { id: uuid(1), title: '我的' });
    expect(c.statusCode).toBe(201);
    expect(c.json().conversation.id).not.toBe(uuid(1));
    const fid = c.json().conversation.id as string;
    await say(familyCookie, { conversationId: fid, model: 'aroomo/xiaobot', messages: [{ role: 'user', content: '家人的话' }] });
    expect((await msgs(familyCookie, fid)).messages[0].content).toBe('家人的话');
    expect((await owner()('GET', '/api/conversations')).json().conversations.map((x: Json) => x.id)).not.toContain(fid);
    // 所有者令牌（Bearer）和所有者账号是同一份数据（scope = owner）
    expect((await e.owner('GET', '/api/conversations')).json().conversations.map((x: Json) => x.id)).toContain(uuid(1));
  });

  it('X-23：请求里自带作者 / userId 字段 400；助手的固定会话在这里看不到、写不进', async () => {
    expect((await owner()('POST', '/api/conversations', { title: 'x', userId: 'someone' })).statusCode).toBe(400);
    expect((await owner()('PATCH', `/api/conversations/${uuid(1)}`, { userId: 'x' })).statusCode).toBe(400);
    const aid = await e.create();
    const convId = (await e.owner('GET', `/api/assistants/${aid}`)).json().assistant.conversationId as string;
    expect((await owner()('GET', `/api/conversations/${convId}`)).statusCode).toBe(404);
    expect((await owner()('GET', '/api/conversations')).json().conversations.map((x: Json) => x.id)).not.toContain(convId);
    expect((await say(ownerCookie, { conversationId: convId, messages: [{ role: 'user', content: '写进助手会话' }] })).statusCode).toBe(404);
    expect((await owner()('PATCH', `/api/conversations/${convId}`, { archived: true })).statusCode).toBe(404);
  });

  it('一次性导入本机会话：按 id 幂等（第二次全跳过），回复带 imported 标记，时间保留；空会话跳过', async () => {
    const body = {
      conversations: [
        { id: uuid(20), title: '本机旧会话', model: 'aroomo', updatedAt: T_UPD, messages: [{ role: 'user', content: '旧问题', at: T_MSG }, { role: 'assistant', content: '旧回答\n\n— 负责人' }] },
        { id: uuid(21), title: '空的', messages: [] },
        { id: uuid(22), title: '模型名坏了', model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] },
      ],
    };
    const r = await owner()('POST', '/api/conversations/import', body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ imported: 2, skipped: 1 });
    const again = await owner()('POST', '/api/conversations/import', body);
    expect(again.json()).toMatchObject({ imported: 0, skipped: 3 });
    const m = await msgs(ownerCookie, uuid(20));
    expect(m.messages.map((x: Json) => [x.role, x.imported ?? false])).toEqual([['user', false], ['assistant', true]]);
    expect(Date.parse(m.messages[0].createdAt)).toBe(T_MSG);
    const conv = (await owner()('GET', `/api/conversations/${uuid(20)}`)).json().conversation;
    expect(Date.parse(conv.updatedAt)).toBe(T_UPD);
    expect(conv.unread).toBe(false);
    expect((await owner()('GET', `/api/conversations/${uuid(22)}`)).json().conversation.model).toBe('aroomo');
    // 导入里带多余字段（作者、draft）→ 400
    expect((await owner()('POST', '/api/conversations/import', { conversations: [{ id: uuid(23), messages: [{ role: 'assistant', content: 'x', draft: {} }] }] })).statusCode).toBe(400);
    expect((await owner()('POST', '/api/conversations/import', { conversations: [{ id: uuid(23), messages: [{ role: 'system', content: 'x' }] }] })).statusCode).toBe(400);
  });

  it('阶段 2 预审：一次性导入只给所有者——家人账号 403（先判权限再校验），什么都不写', async () => {
    const body = { conversations: [{ id: uuid(30), title: '家人想导入', messages: [{ role: 'user', content: '旧问题' }] }] };
    const r = await family()('POST', '/api/conversations/import', body);
    expect(r.statusCode, r.body).toBe(403);
    expect((await family()('POST', '/api/conversations/import', { conversations: 'x' })).statusCode).toBe(403);
    expect((await family()('GET', `/api/conversations/${uuid(30)}`)).statusCode).toBe(404);
    expect((await owner()('GET', `/api/conversations/${uuid(30)}`)).statusCode).toBe(404);
  });

  it('没登录 401；操作员式的无效令牌 401', async () => {
    expect((await e.app.inject({ method: 'GET', url: '/api/conversations' })).statusCode).toBe(401);
    expect((await e.app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: 'Bearer nope-0000' } })).statusCode).toBe(401);
  });
});

describe('「进行中」（X-27 / X-22）', () => {
  it('生成期间会话算进行中，结束后不算；只算自己账号的', async () => {
    const now = () => new Date('2026-11-05T07:00:00Z');
    const svc = new ConversationService({ store: new MemoryConversationStore(), now });
    const a = (await svc.create('owner', { title: 'a' })).conversation.id;
    await svc.create('u-other', { title: 'b' });
    const end = svc.running.begin('owner', a);
    expect((await svc.list('owner', { filter: 'running', archived: false, limit: 10 })).conversations.map((c) => [c.id, c.running])).toEqual([[a, true]]);
    expect((await svc.list('u-other', { filter: 'running', archived: false, limit: 10 })).conversations).toEqual([]);
    end();
    end();
    expect((await svc.list('owner', { filter: 'running', archived: false, limit: 10 })).conversations).toEqual([]);
    expect((await svc.list('owner', { filter: 'all', archived: false, limit: 10 })).conversations[0]!.running).toBe(false);
  });
});
