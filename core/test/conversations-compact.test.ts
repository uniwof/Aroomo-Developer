/**
 * X-19 长会话自动压缩（docs/api/design-search-compaction-v1.md §2）：Compactor 单元（memory + PGlite + CI 真 PG），
 * freeSummarizer 只用免费成员；/api/chat/stream 端到端（导入一段长会话 → 下一句前压缩，原文一条不少）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Compactor, freeSummarizer, SUMMARY_PREFIX, type Summarize, type Turn } from '../src/conversations/compact.js';
import { MemoryConversationStore } from '../src/conversations/memory.js';
import { PgConversationStore } from '../src/conversations/pg.js';
import type { ChatConversation, ConversationStore } from '../src/conversations/types.js';
import type { Member } from '../src/members/types.js';
import { hashPassword } from '../src/users/password.js';
import { assistantEnv, type AssistantEnv, LEAD } from './helpers/assistants.js';
import { dbTargets } from './helpers/db.js';
import { fakePw, twoAccountEnvs } from './helpers/two-accounts.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const U = 'owner';
const CID = '22222222-2222-4222-8222-000000000001';
const T0 = Date.UTC(2026, 10, 5, 6, 0); // 11-05 14:00 CST

const stores: Array<{ name: string; open: () => Promise<{ store: ConversationStore; close: () => Promise<void> }> }> = [
  { name: 'memory', open: async () => ({ store: new MemoryConversationStore(), close: async () => undefined }) },
  ...dbTargets.map((t) => ({ name: t.name, open: async () => { const db = await t.open(); return { store: new PgConversationStore(db), close: () => db.close() }; } })),
];

describe.each(stores)('Compactor [$name]', (target) => {
  let store: ConversationStore;
  let close: () => Promise<void>;
  let clock = T0;
  const now = () => new Date(clock);
  let n = 0;
  const conv = (id: string): ChatConversation => ({ id, userId: U, title: '长会话', model: 'aroomo', groupNames: [], readAt: null, archivedAt: null, createdAt: now(), updatedAt: now() });
  const add = async (cid: string, role: 'user' | 'assistant', content: string) => {
    clock += 60_000;
    const m = await store.append(U, { id: `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`, conversationId: cid, userId: U, role, content, meta: null, createdAt: now() });
    expect(m).not.toBeNull();
    return m!;
  };
  const all = async (cid: string) => store.messages(U, cid, { limit: 1000 });
  const sig = () => new AbortController().signal;
  const make = (summarize: Summarize, limits = {}) => new Compactor({ store, summarize, now, timezone: 'Asia/Shanghai', limits: { at: 100, keep: 40, inputMax: 1000, perMessage: 200, ...limits } });

  beforeAll(async () => {
    ({ store, close } = await target.open());
  });
  afterAll(async () => close());

  it('没超上限、没有摘要：原样用浏览器发来的消息，不调摘要', async () => {
    const cid = '22222222-2222-4222-8222-000000000010';
    await store.create(U, conv(cid));
    await add(cid, 'user', '你好');
    let calls = 0;
    const browser: Turn[] = [{ role: 'user', content: '你好' }];
    const p = await make(async () => (calls++, 'x')).prepare(U, cid, browser, false, sig());
    expect(p).toEqual({ messages: browser, compacted: null });
    expect(calls).toBe(0);
  });

  it('超了：较早的交给摘要，追加一行摘要（role system，原文不删）；发给模型的是 [摘要] + 留下的原文；下一句接着用这份摘要', async () => {
    await store.create(U, conv(CID));
    for (let i = 0; i < 6; i++) await add(CID, i % 2 ? 'assistant' : 'user', `第${i}条-${'甲'.repeat(20)}`); // 每条 23 字，共 138 字
    const last = await add(CID, 'user', '现在呢');
    const seen: Turn[][] = [];
    const c = make(async (_u, ms) => (seen.push(ms), '摘要一：说了 0 到 4 条'));
    const p = await c.prepare(U, CID, [{ role: 'user', content: '现在呢' }], false, sig());
    // 留 ≤ 40 字：最后一句（3 字）+ 第 5 条（23 字）；再加第 4 条就超
    expect(p.compacted).toMatchObject({ keep: 2 });
    expect(p.compacted!.text).toMatch(/^已把 11-05 14:\d\d 之前的内容整理成摘要，原文还在，可以往上翻$/);
    expect(p.messages).toEqual([
      { role: 'system', content: `${SUMMARY_PREFIX}摘要一：说了 0 到 4 条` },
      { role: 'assistant', content: `第5条-${'甲'.repeat(20)}` },
      { role: 'user', content: '现在呢' },
    ]);
    // 摘要的输入：系统说明 + 第 0–4 条（不含留下的）
    expect(seen[0]![1]!.content).toContain('用户：第0条');
    expect(seen[0]![1]!.content).toContain('用户：第4条');
    expect(seen[0]![1]!.content).not.toContain('第5条');
    const rows = await all(CID);
    expect(rows.filter((m) => m.role !== 'system')).toHaveLength(7); // 原文一条不少
    const sum = rows.at(-1)!;
    expect(sum).toMatchObject({ role: 'system', content: p.compacted!.text });
    expect(sum.meta?.summary).toMatchObject({ text: '摘要一：说了 0 到 4 条', keep: 2 });
    expect(sum.meta!.summary!.toSeq).toBe(rows[4]!.seq);
    expect(sum.meta!.summary!.toSeq).toBeLessThan(last.seq!);

    // 下一句：没超 → [摘要] + 摘要之后的原文（浏览器发来的历史不用）
    await add(CID, 'assistant', '回复');
    await add(CID, 'user', '再问');
    const q = await c.prepare(U, CID, [{ role: 'user', content: '再问' }], false, sig());
    expect(q.compacted).toBeNull();
    expect(q.messages.map((m) => m.content)).toEqual([`${SUMMARY_PREFIX}摘要一：说了 0 到 4 条`, `第5条-${'甲'.repeat(20)}`, '现在呢', '回复', '再问']);

    // 再超：新摘要的输入里带着旧摘要
    for (let i = 0; i < 4; i++) await add(CID, i % 2 ? 'user' : 'assistant', `后面${i}-${'乙'.repeat(20)}`);
    const r = await c.prepare(U, CID, [{ role: 'user', content: `后面3-${'乙'.repeat(20)}` }], false, sig());
    expect(r.compacted).not.toBeNull();
    expect(seen[1]![1]!.content).toMatch(/^之前的摘要：\n摘要一：说了 0 到 4 条/);
    expect((await store.latestSummary(U, CID))!.meta!.summary!.text).toBe('摘要一：说了 0 到 4 条');
  });

  it('重试：最后一句用户话之后的旧回复不算；库里对不上（这句没存进去）就原样用浏览器的', async () => {
    const cid = '22222222-2222-4222-8222-000000000020';
    await store.create(U, conv(cid));
    for (let i = 0; i < 6; i++) await add(cid, i % 2 ? 'assistant' : 'user', `r${i}-${'丙'.repeat(20)}`);
    await add(cid, 'user', '重试这句');
    await add(cid, 'assistant', '上次停在一半的回复');
    const p = await make(async () => '摘要').prepare(U, cid, [{ role: 'user', content: '重试这句' }], true, sig());
    expect(p.messages.at(-1)).toEqual({ role: 'user', content: '重试这句' });
    expect(p.messages.map((m) => m.content)).not.toContain('上次停在一半的回复');

    const browser: Turn[] = [{ role: 'user', content: '库里没有这句' }];
    expect(await make(async () => '摘要').prepare(U, cid, browser, false, sig())).toEqual({ messages: browser, compacted: null });
  });

  it('摘要失败 / 没有免费成员：不写摘要，只发最近的原文（上限内）；当天次数用完不再调摘要', async () => {
    const cid = '22222222-2222-4222-8222-000000000030';
    await store.create(U, conv(cid));
    for (let i = 0; i < 8; i++) await add(cid, i % 2 ? 'assistant' : 'user', `f${i}-${'丁'.repeat(20)}`);
    await add(cid, 'user', '最后');
    const before = (await all(cid)).length;
    const p = await make(async () => null).prepare(U, cid, [{ role: 'user', content: '最后' }], false, sig());
    expect(p.compacted).toBeNull();
    expect(p.messages.every((m) => m.role !== 'system')).toBe(true);
    expect(p.messages.reduce((x, m) => x + m.content.length, 0)).toBeLessThanOrEqual(100);
    expect(p.messages.at(-1)!.content).toBe('最后');
    expect(await all(cid)).toHaveLength(before);

    // 每天上限：今天已经有摘要（上面的用例写过）→ perDay = 1 时不再调
    let calls = 0;
    const q = await make(async () => (calls++, '摘要'), { perDay: 1 }).prepare(U, cid, [{ role: 'user', content: '最后' }], false, sig());
    expect(calls).toBe(0);
    expect(q.compacted).toBeNull();
    // 摘要函数抛错也不打断对话
    const r = await make(async () => { throw new Error('boom'); }).prepare(U, cid, [{ role: 'user', content: '最后' }], false, sig());
    expect(r.compacted).toBeNull();
  });

  it('别的账号的会话：取不到尾部 → 原样用浏览器的，不写进别人的会话', async () => {
    const browser: Turn[] = [{ role: 'user', content: '现在呢' }];
    const p = await new Compactor({ store, summarize: async () => '摘要', now, timezone: 'Asia/Shanghai', limits: { at: 1 } }).prepare('u-other', CID, browser, false, sig());
    expect(p).toEqual({ messages: browser, compacted: null });
    expect(await store.latestSummary('u-other', CID)).toBeNull();
  });
});

describe('freeSummarizer：只用免费成员', () => {
  const member = (id: string, maxInputTokens: number | null): Member =>
    ({ id, name: id, aliases: [], enabled: true, status: 'active', deletedAt: null, modelCaps: maxInputTokens === null ? null : { mode: 'chat', maxInputTokens, supportsTools: false, checkedAt: '' } }) as unknown as Member;
  const ok = (content: string) => ({ status: 200, headers: {}, json: { choices: [{ message: { content } }] } });

  it('几位都免费时挑 maxInputTokens 最大的；付费成员不用；走 aroomo/<成员>、不流式', async () => {
    const calls: Json[] = [];
    const s = freeSummarizer({
      membersFor: () => ({ listAll: async () => [member('paid', 2_000_000), member('small', 8000), member('big', 1_000_000)] }),
      deploymentsFor: async () => [
        { modelName: 'paid', model: 'openai/gpt-5' },
        { modelName: 'small', model: 'groq/gpt-oss-120b' },
        { modelName: 'big', model: 'gemini/x' },
      ],
      isFree: (m) => m !== 'openai/gpt-5',
      chatFor: () => async (req) => (calls.push(req), ok('摘要')),
    });
    expect(await s('owner', [{ role: 'user', content: 'x' }], new AbortController().signal)).toBe('摘要');
    expect(calls).toEqual([{ model: 'aroomo/big', stream: false, messages: [{ role: 'user', content: 'x' }] }]);
  });

  it('没有免费成员（或没有 Key 部署）→ null，不调模型；调用失败 → null', async () => {
    let calls = 0;
    const none = freeSummarizer({
      membersFor: () => ({ listAll: async () => [member('paid', null), member('nokey', null)] }),
      deploymentsFor: async () => [{ modelName: 'paid', model: 'openai/gpt-5' }],
      chatFor: () => async () => (calls++, ok('x')),
    });
    expect(await none('owner', [], new AbortController().signal)).toBeNull();
    expect(calls).toBe(0);
    const failing = freeSummarizer({
      membersFor: () => ({ listAll: async () => [member('f', null)] }),
      deploymentsFor: async () => [{ modelName: 'f', model: 'groq/gpt-oss-120b' }],
      chatFor: () => async () => ({ ...ok('出错提示'), failure: { code: 'rate_limited' as const } }),
    });
    expect(await failing('owner', [], new AbortController().signal)).toBeNull();
  });
});

describe.each(twoAccountEnvs)('/api/chat/stream 长会话自动压缩 [$name]', (env) => {
  let e: AssistantEnv;
  let cookie = '';
  const OWNER_ACCOUNT_ID = '4e000000-0000-4000-8000-00000000c019';
  beforeAll(async () => {
    e = await assistantEnv(env, { extraEnv: { CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID, CORE_CHAT_TOKEN: 'placeholder-chat-token-0123456789abcdefgh' } });
    const at = e.clock.now();
    const pw = fakePw(19);
    await e.deps.users.insertUser({ id: OWNER_ACCOUNT_ID, email: 'owner-x19@example.test', displayName: '宝宝', role: 'admin', status: 'active', passwordHash: await hashPassword(pw), createdAt: at, updatedAt: at });
    const r = await e.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'owner-x19@example.test', password: pw, cookie: true } });
    cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const lead = (await e.deps.members.get(LEAD.id))!;
    await e.deps.members.update({ ...lead, modelCaps: { mode: 'chat', maxInputTokens: 128000, supportsTools: true, checkedAt: at.toISOString() } });
  });
  afterAll(async () => e.closeAll());
  const call = (method: 'GET' | 'POST', url: string, payload?: object) => e.app.inject({ method, url, headers: { cookie, 'x-aroomo-request': '1' }, ...(payload ? { payload } : {}) });

  it('导入一段 3 万字的会话 → 下一句前用免费成员压缩：流里有 data-aroomo-compacted，会话里多一行灰字，原文一条不少', async () => {
    const id = '22222222-2222-4222-8222-0000000000c1';
    const base = e.clock.now().getTime() - 3_600_000;
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}-${'长'.repeat(1000)}`, at: base + i * 1000 }));
    const imp = await call('POST', '/api/conversations/import', { conversations: [{ id, title: '很长', messages }] });
    expect(imp.json(), imp.body).toMatchObject({ imported: 1 });
    e.gw.calls.length = 0;
    const r = await call('POST', '/api/chat/stream', { conversationId: id, messages: [{ role: 'user', content: '接着说' }] });
    expect(r.statusCode, r.body).toBe(200);
    const part = r.body.split('\n\n').map((x) => x.trim()).filter((x) => x.includes('data-aroomo-compacted')).map((x) => JSON.parse(x.slice(5)) as Json)[0];
    expect(part).toMatchObject({ transient: true, data: { keep: 8 } }); // 「接着说」+ 最后 7 条（每条 1002 字）≤ 8000 字
    expect(part!.data.text).toMatch(/^已把 \d\d-\d\d \d\d:\d\d 之前的内容整理成摘要，原文还在，可以往上翻$/);
    expect(e.gw.calls).toEqual([LEAD.name, LEAD.name]); // 一次摘要（免费成员）+ 一次回复
    const m = (await call('GET', `/api/conversations/${id}/messages?limit=200`)).json() as Json;
    const roles = m.messages.map((x: Json) => x.role);
    expect(roles.filter((x: string) => x !== 'system')).toHaveLength(32); // 30 条导入 + 这句 + 回复
    const sys = m.messages.find((x: Json) => x.role === 'system');
    expect(sys).toMatchObject({ content: part!.data.text, summary: { toSeq: m.messages[22].seq } });
    expect(sys.summary.text).toBeUndefined(); // 摘要正文不出 Core
    // 搜索不会搜到灰字
    expect((await call('GET', `/api/search?q=${encodeURIComponent('整理成摘要')}`)).json().results).toEqual([]);
  });
});
