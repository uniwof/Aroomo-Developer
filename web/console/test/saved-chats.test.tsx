/**
 * 会话存库（#250 integrate/stage2，FLAGS.savedChats）：对话列表从 Core 读；所有者的本机旧会话导入一次（本机那份不删）；
 * 「全部 / 未读 / 进行中」也作用到对话；发消息带 conversationId；Core 拿不到时退回本机；收件箱条目能打开对应会话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage, LIST_WAIT_MS } from '@/chat/ChatPage';
import { conversationLink } from '@/pages/Inbox';
import { IMPORTED_KEY, importLocalOnce, isUuid, mergeRemote } from '@/chat/saved';
import { loadConversations, saveConversations, streamChat, type Conversation } from '@/chat/store';
// 这组测试测的是阶段 2/3 开关打开后的行为（以后验收、打开时用）。阶段 1.5 发布默认全关，关着的样子见 release-15-flags-off.test.tsx
vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false } }));

const enc = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stream = (text: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const o of [{ type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish' }]) c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const LOCAL = 'cccccccc-0000-4000-8000-000000000003';
const C = 'ffffffff-0000-4000-8000-000000000006';
const MSG = 'dddddddd-0000-4000-8000-000000000004';
const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  model: 'aroomo',
  group: [],
  archived: false,
  unread: false,
  running: false,
  messageCount: 2,
  last: { role: 'assistant', preview: `${title}的回复`, createdAt: '2026-11-05T06:00:00.000Z' },
  readAt: null,
  createdAt: '2026-11-05T05:00:00.000Z',
  updatedAt: '2026-11-05T06:00:00.000Z',
  ...over,
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubCore(opts: { fail?: boolean; listGate?: Promise<void>; extra?: ReturnType<typeof row>[] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/assistants') return json({ assistants: [] });
      if (url.startsWith('/api/conversations') && opts.fail) return json({ error: { code: 'X', message: '坏了' } }, 503);
      if (url === '/api/conversations/import') return json({ imported: body.conversations.length, skipped: 0, ids: {} });
      if (url.startsWith('/api/conversations?') && opts.listGate) await opts.listGate;
      if (url.startsWith('/api/conversations?'))
        return json({
          conversations: [row(A, '周末去哪'), row(B, '买菜清单', { running: true, updatedAt: '2026-11-05T05:30:00.000Z' }), row(C, '读书笔记', { unread: true, updatedAt: '2026-11-05T05:00:00.000Z' }), ...(opts.extra ?? [])],
          nextCursor: null,
        });
      if (url.endsWith('/messages?limit=200'))
        return json({
          messages: [
            { id: MSG, seq: 1, role: 'user', content: '周末去哪玩', createdAt: '2026-11-05T05:59:00.000Z' },
            { id: 'eeeeeeee-0000-4000-8000-000000000005', seq: 2, role: 'assistant', content: '去公园走走\n\n— 负责人', createdAt: '2026-11-05T06:00:00.000Z' },
          ],
          hasMore: false,
        });
      if (url.endsWith('/read')) return new Response(null, { status: 204 });
      if (url === '/api/conversations' && method === 'POST') return json({ conversation: row(body.id, body.title, { messageCount: 0, last: null }), created: true }, 201);
      return json({}, 404);
    }),
  );
  return calls;
}

const renderPage = (fetchImpl?: typeof fetch) =>
  render(
    <MemoryRouter>
      <ChatPage {...(fetchImpl ? { fetchImpl } : {})} />
    </MemoryRouter>,
  );

const local: Conversation = { id: LOCAL, title: '本机的旧会话', model: 'aroomo', messages: [{ role: 'user', text: '旧问题', at: 1 }, { role: 'assistant', text: '旧回答' }], updatedAt: 2 };

describe('会话存库（对话页）', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('所有者：本机旧会话导入一次（本机那份留着）；列表来自 Core；对话也有「全部 / 未读 / 进行中」', async () => {
    saveConversations([local]);
    const calls = stubCore();
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    // 打开页面时停在最近的会话上（它算已读）；别的未读会话有小点
    await within(list).findByRole('button', { name: /读书笔记.*有新回复/ });
    const imp = calls.find((c) => c.url === '/api/conversations/import')!;
    expect((imp.body as { conversations: Array<{ id: string; messages: unknown[] }> }).conversations).toMatchObject([{ id: LOCAL, messages: [{ role: 'user', content: '旧问题', at: 1 }, { role: 'assistant', content: '旧回答' }] }]);
    expect(JSON.parse(localStorage.getItem(IMPORTED_KEY)!)).toEqual([LOCAL]);
    expect(loadConversations().map((c) => c.id)).toEqual([LOCAL]);
    // 「买菜清单」进行中：静态小标，排最前
    const names = within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
    expect(names[0]).toMatch(/^买菜清单，进行中/);
    const g = screen.getByRole('radiogroup', { name: '筛选对话' });
    fireEvent.click(within(g).getByRole('radio', { name: '未读' }));
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^读书笔记/)]);
    fireEvent.click(within(g).getByRole('radio', { name: '进行中' }));
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^买菜清单/)]);
  });

  it('点开存库的会话：取消息、标已读；第二次打开页面不再导入', async () => {
    saveConversations([local]);
    localStorage.setItem(IMPORTED_KEY, JSON.stringify([LOCAL]));
    const calls = stubCore();
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    fireEvent.click(await within(list).findByRole('button', { name: /^读书笔记/ }));
    expect(await screen.findByText('周末去哪玩')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === `/api/conversations/${C}/read` && c.method === 'POST')).toBe(true));
    expect(calls.some((c) => c.url === '/api/conversations/import')).toBe(false);
    // 存库的会话：「删除话题」换成「归档话题」
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('button', { name: /归档会话「读书笔记」/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除会话/ })).toBeNull();
  });

  it('新会话发第一句：先在 Core 建会话（用本机 id、第一句当标题），流请求带 conversationId', async () => {
    const calls = stubCore();
    const chat: RequestInit[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      chat.push(init);
      return stream('好的');
    }) as unknown as typeof fetch;
    renderPage(f);
    await screen.findByRole('radiogroup', { name: '筛选对话' });
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '明天提醒我买牛奶' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await within(screen.getByRole('log', { name: '对话内容' })).findByText('好的');
    const made = calls.find((c) => c.url === '/api/conversations' && c.method === 'POST')!;
    expect(made.body).toMatchObject({ title: '明天提醒我买牛奶', model: 'aroomo' });
    const body = JSON.parse(String(chat[0]!.body)) as Record<string, unknown>;
    expect(body.conversationId).toBe((made.body as { id: string }).id);
    expect(body.retry).toBeUndefined();
    // 存库模式不写本机
    expect(loadConversations()).toEqual([]);
  });

  it('出错后「重试」：Core 已收下用户那句 → 重试带 retry（不重复存）；同一个会话 id', async () => {
    stubCore();
    const chat: RequestInit[] = [];
    let n = 0;
    const f = (async (_u: unknown, init: RequestInit) => {
      chat.push(init);
      n++;
      if (n === 1)
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'error', errorText: '模型出错了，请稍后重试。' })}\n\ndata: [DONE]\n\n`));
              c.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      return stream('第二次好了');
    }) as unknown as typeof fetch;
    renderPage(f);
    await screen.findByRole('radiogroup', { name: '筛选对话' });
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '重试这条回复' }));
    await within(screen.getByRole('log', { name: '对话内容' })).findByText('第二次好了');
    const [first, second] = chat.map((c) => JSON.parse(String(c.body)) as Record<string, unknown>);
    expect(first!.retry).toBeUndefined();
    expect(second).toMatchObject({ conversationId: first!.conversationId, retry: true });
  });

  it('列表还没到就发了一句：先排队，列表到了在 Core 建会话再发，话不丢', async () => {
    let open!: () => void;
    const calls = stubCore({ listGate: new Promise<void>((r) => (open = r)) });
    const chat: RequestInit[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      chat.push(init);
      return stream('收到了');
    }) as unknown as typeof fetch;
    renderPage(f);
    const log = () => within(screen.getByRole('log', { name: '对话内容' }));
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '列表没到我先说' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await log().findByText('列表没到我先说')).toBeInTheDocument();
    // 还在等列表：不发流请求、不建会话
    await new Promise((r) => setTimeout(r, 50));
    expect(chat).toHaveLength(0);
    expect(calls.some((c) => c.url === '/api/conversations' && c.method === 'POST')).toBe(false);
    open();
    expect(await log().findByText('收到了')).toBeInTheDocument();
    const made = calls.find((c) => c.url === '/api/conversations' && c.method === 'POST')!;
    expect(made.body).toMatchObject({ title: '列表没到我先说' });
    expect(JSON.parse(String(chat[0]!.body))).toMatchObject({ conversationId: (made.body as { id: string }).id });
    // 列表盖上来以后这句还在，会话也在列表里
    const list = await screen.findByRole('list', { name: '会话列表' });
    await within(list).findByRole('button', { name: /^列表没到我先说/ });
    expect(log().getByText('列表没到我先说')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /^周末去哪/ })).toBeInTheDocument();
  });

  it('列表一直不到：等够时间就退回本机，这句照发、存本机，晚到的列表不再把它盖掉', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let open!: () => void;
      const calls = stubCore({ listGate: new Promise<void>((r) => (open = r)) });
      const chat: RequestInit[] = [];
      const f = (async (_u: unknown, init: RequestInit) => {
        chat.push(init);
        return stream('本机先回');
      }) as unknown as typeof fetch;
      renderPage(f);
      fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '一直等不到' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await vi.advanceTimersByTimeAsync(LIST_WAIT_MS + 10);
      const log = within(screen.getByRole('log', { name: '对话内容' }));
      expect(await log.findByText('本机先回')).toBeInTheDocument();
      expect(JSON.parse(String(chat[0]!.body))).not.toHaveProperty('conversationId');
      await waitFor(() => expect(loadConversations().flatMap((c) => c.messages.map((m) => m.text))).toContain('一直等不到'));
      open();
      await vi.advanceTimersByTimeAsync(50);
      expect(log.getByText('一直等不到')).toBeInTheDocument();
      expect(calls.some((c) => c.url === '/api/conversations' && c.method === 'POST')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('列表没到时在本机旧会话里接着说：列表到了用 Core 那份，但新说的话留着并带上 conversationId', async () => {
    saveConversations([local]);
    localStorage.setItem(IMPORTED_KEY, JSON.stringify([LOCAL]));
    let open!: () => void;
    // 这个旧会话之前已经导入过，Core 里有同一个 id
    const calls = stubCore({ listGate: new Promise<void>((r) => (open = r)), extra: [row(LOCAL, '本机的旧会话', { updatedAt: '2026-11-05T07:00:00.000Z' })] });
    const chat: RequestInit[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      chat.push(init);
      return stream('接着回');
    }) as unknown as typeof fetch;
    renderPage(f);
    const log = () => within(screen.getByRole('log', { name: '对话内容' }));
    expect(await log().findByText('旧问题')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '旧会话里新说一句' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await log().findByText('旧会话里新说一句')).toBeInTheDocument();
    open();
    expect(await log().findByText('接着回')).toBeInTheDocument();
    expect(log().getByText('旧会话里新说一句')).toBeInTheDocument();
    // 用 Core 里已有的那个会话（不再新建），旧话和新话都带上
    const body = JSON.parse(String(chat[0]!.body)) as { conversationId: string; messages: unknown[] };
    expect(body.conversationId).toBe(LOCAL);
    expect(JSON.stringify(body.messages)).toContain('旧问题');
    expect(calls.some((c) => c.url === '/api/conversations' && c.method === 'POST')).toBe(false);
    expect(log().getByText('旧问题')).toBeInTheDocument();
  });

  it('Core 拿不到：退回本机列表，发消息不带 conversationId，照旧存本机', async () => {
    saveConversations([local]);
    stubCore({ fail: true });
    const chat: RequestInit[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      chat.push(init);
      return stream('本机回复');
    }) as unknown as typeof fetch;
    renderPage(f);
    const list = await screen.findByRole('list', { name: '会话列表' });
    expect(within(list).getByRole('button', { name: /本机的旧会话/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: '筛选对话' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await within(screen.getByRole('log', { name: '对话内容' })).findByText('本机回复');
    expect(JSON.parse(String(chat[0]!.body))).not.toHaveProperty('conversationId');
    await waitFor(() => expect(loadConversations()).toHaveLength(2));
  });
});

describe('会话存库（零件）', () => {
  it('收件箱条目的会话链接（X-04b）：会话 id 或「会话 id:消息 id」，别的不认', () => {
    expect(conversationLink({ related: { type: 'conversation', id: A } })).toEqual({ conversationId: A });
    expect(conversationLink({ related: { type: 'conversation', id: `${A}:${MSG}` } })).toEqual({ conversationId: A, messageId: MSG });
    expect(conversationLink({ related: { type: 'conversation', id: 'javascript:alert(1)' } })).toBeNull();
    expect(conversationLink({ related: { type: 'assistant_run', id: A } })).toBeNull();
    expect(conversationLink({})).toBeNull();
  });

  it('导入：本机旧 id 不是 uuid 时按它算固定的 uuid（两台设备各导一次也是同一个会话）', async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init!.body)).conversations[0].id);
        return json({ imported: 1, skipped: 0, ids: {} });
      }),
    );
    const old: Conversation = { ...local, id: 'c1730000000000abc' };
    const mem = () => {
      const m = new Map<string, string>();
      return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
    };
    await importLocalOnce([old], mem());
    await importLocalOnce([old], mem());
    expect(sent).toHaveLength(2);
    expect(isUuid(sent[0]!)).toBe(true);
    expect(sent[1]).toBe(sent[0]);
    vi.unstubAllGlobals();
  });

  it('streamChat：给了 conversationId / retry 才带上；Core 收下后回调', async () => {
    const bodies: unknown[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return stream('x');
    }) as unknown as typeof fetch;
    const accepted = vi.fn();
    for await (const _ of streamChat([{ role: 'user', text: 'hi' }], 'aroomo', new AbortController().signal, f, undefined, { conversationId: A, retry: true, onAccepted: accepted })) void _;
    expect(bodies[0]).toEqual({ model: 'aroomo', messages: [{ role: 'user', content: 'hi' }], conversationId: A, retry: true });
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('列表刷新合并：Core 的未读 / 进行中盖上来；已取的消息、正打开的会话留着；别处有新消息的下次重取', () => {
    const loaded = (id: string, n: number): Conversation => ({ id, title: 'old', model: 'aroomo', messages: Array.from({ length: n }, () => ({ role: 'user' as const, text: 'x' })), updatedAt: 1, remote: { loaded: true, unread: false, running: false, count: n } });
    const fresh = (id: string, count: number): Conversation => ({ id, title: 'new', model: 'aroomo', messages: [], updatedAt: 5, remote: { loaded: false, unread: true, running: false, count } });
    const localNew: Conversation = { id: LOCAL, title: '新对话', model: 'aroomo', messages: [], updatedAt: 9 };
    const out = mergeRemote([loaded(A, 2), loaded(B, 2), localNew], [fresh(A, 2), fresh(B, 3)], A);
    expect(out.map((c) => [c.id, c.title, c.messages.length, c.remote?.loaded ?? null, c.remote?.unread ?? null])).toEqual([
      [LOCAL, '新对话', 0, null, null],
      [A, 'new', 2, true, true],
      [B, 'new', 0, false, true],
    ]);
  });
});
