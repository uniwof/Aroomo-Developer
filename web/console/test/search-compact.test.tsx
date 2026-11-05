/**
 * X-09 会话搜索（对话栏搜索框下面的「消息」一组 → 打开会话并停在那条消息）+ X-19 长会话压缩的灰字 + 发送历史上限。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { capTurns, parseEvent, SEND_MAX_TURNS, streamChat, type ChatTurn } from '@/chat/store';

const enc = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const HIT = 'dddddddd-0000-4000-8000-0000000000b2';
const KEPT = 'eeeeeeee-0000-4000-8000-0000000000a3';
const NOTE = '已把 11-05 13:58 之前的内容整理成摘要，原文还在，可以往上翻';
const row = (id: string, title: string, updatedAt: string) => ({
  id, title, model: 'aroomo', group: [], archived: false, unread: false, running: false, messageCount: 3,
  last: { role: 'assistant', preview: `${title}的回复`, createdAt: updatedAt }, readAt: null, createdAt: updatedAt, updatedAt,
});

function stubCore(search: (q: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/assistants') return json({ assistants: [] });
      if (url.startsWith('/api/search?')) return search(new URL(url, 'http://x').searchParams.get('q') ?? '');
      if (url.startsWith('/api/conversations?'))
        return json({ conversations: [row(A, '周末去哪', 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)'), row(B, '买菜清单', 'Thu 2026-11-05 1:00 PM CST (UTC+08:00)')], nextCursor: null });
      if (url === `/api/conversations/${A}/messages?limit=200`)
        return json({
          messages: [
            { id: 'aaaaaaaa-1111-4000-8000-000000000001', seq: 1, role: 'user', content: '很早的话', createdAt: 'Thu 2026-11-05 1:50 PM CST (UTC+08:00)' },
            { id: KEPT, seq: 2, role: 'user', content: '留下的第一条', createdAt: 'Thu 2026-11-05 1:58 PM CST (UTC+08:00)' },
            { id: 'aaaaaaaa-1111-4000-8000-000000000003', seq: 3, role: 'system', content: NOTE, summary: { toSeq: 1 }, createdAt: 'Thu 2026-11-05 1:59 PM CST (UTC+08:00)' },
            { id: 'aaaaaaaa-1111-4000-8000-000000000004', seq: 4, role: 'assistant', content: '回复', createdAt: 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)' },
          ],
          hasMore: false,
        });
      if (url === `/api/conversations/${B}/messages?limit=200`)
        return json({
          messages: [
            { id: 'bbbbbbbb-1111-4000-8000-000000000001', seq: 5, role: 'user', content: '买点菜', createdAt: 'Thu 2026-11-05 12:58 PM CST (UTC+08:00)' },
            { id: HIT, seq: 6, role: 'assistant', content: '记得买西红柿和鸡蛋', createdAt: 'Thu 2026-11-05 1:00 PM CST (UTC+08:00)' },
          ],
          hasMore: false,
        });
      if (url.endsWith('/read')) return new Response(null, { status: 204 });
      return json({}, 404);
    }),
  );
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );

const W = { timeout: 5000 };

describe('X-09 会话搜索', () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom 没有 scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('输入后下面多一组「消息」：结果有会话名、片段（读屏读出整句）；点一条打开那个会话、停在那条消息上', async () => {
    const calls = stubCore((q) => json({ results: q === '西红柿' ? [{ conversationId: B, title: '买菜清单', messageId: HIT, seq: 6, role: 'assistant', snippet: '记得买西红柿和鸡蛋', createdAt: 'Thu 2026-11-05 1:00 PM CST (UTC+08:00)' }] : [], nextBeforeSeq: null }));
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    const box = screen.getByRole('searchbox', { name: '搜索对话' });
    fireEvent.change(box, { target: { value: '西红柿' } });
    const results = await screen.findByRole('list', { name: '消息搜索结果' }, W);
    const btn = within(results).getByRole('button', { name: /^买菜清单，回复：记得买西红柿和鸡蛋，.*打开并跳到这条$/ });
    expect(calls.filter((c) => c.startsWith('GET /api/search')).at(-1)).toBe(`GET /api/search?q=${encodeURIComponent('西红柿')}&limit=20`);
    // 读屏播报结果数
    expect(screen.getByText('消息里找到 1 条')).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(document.getElementById(`msg-${HIT}`)).toHaveClass('msg-focus'), W);
    expect(document.activeElement).toBe(document.getElementById(`msg-${HIT}`));
  });

  it('消息里没有、标题里也没有：一句「没有找到」；搜不了：说清楚 + 「重试」能再搜', async () => {
    let fail = true;
    stubCore(() => (fail ? json({ error: { code: 'X', message: '坏了' } }, 503) : json({ results: [], nextBeforeSeq: null })));
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索对话' }), { target: { value: '没有的词' } });
    expect(await screen.findByText(/没能搜消息：连不上 Aroomo/, {}, W)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('没有找到。换个词试试。', {}, W)).toBeInTheDocument();
  });

  it('Ctrl+K / ⌘K 聚焦搜索框', async () => {
    stubCore(() => json({ results: [], nextBeforeSeq: null }));
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    const box = screen.getByRole('searchbox', { name: '搜索对话' });
    // jsdom 没有布局：offsetParent 恒为 null，这里补上「看得见」
    Object.defineProperty(box, 'offsetParent', { configurable: true, get: () => document.body });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(box);
  });
});

describe('X-19 长会话压缩', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('摘要行不当消息显示：变成「留下的第一条原文」上面的一行静态灰字（role=note）', async () => {
    stubCore(() => json({ results: [], nextBeforeSeq: null }));
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    fireEvent.click(await within(list).findByRole('button', { name: /^周末去哪/ }, W));
    const note = await screen.findByRole('note', {}, W);
    expect(note).toHaveTextContent(NOTE);
    expect(document.getElementById(`msg-${KEPT}`)).toContainElement(note);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  it('流里的 data-aroomo-compacted → onCompacted；发给 Core 的历史最多 100 条、12 万字（至少最后一句）', async () => {
    expect(parseEvent(`data: ${JSON.stringify({ type: 'data-aroomo-compacted', data: { keep: 3, text: NOTE }, transient: true })}`)).toEqual({ type: 'compacted', keep: 3, text: NOTE });
    const turns: ChatTurn[] = Array.from({ length: 150 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第${i}条` }));
    expect(capTurns(turns)).toHaveLength(SEND_MAX_TURNS);
    expect(capTurns(turns).at(-1)!.text).toBe('第149条');
    const big: ChatTurn[] = [{ role: 'user', text: 'a'.repeat(100_000) }, { role: 'assistant', text: 'b'.repeat(30_000) }, { role: 'user', text: 'c'.repeat(200_000) }];
    expect(capTurns(big).map((t) => t.text[0])).toEqual(['c']);

    let sent: { messages: unknown[] } | null = null;
    const f = (async (_u: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        new ReadableStream({
          start(c) {
            for (const o of [{ type: 'start' }, { type: 'data-aroomo-compacted', data: { keep: 2, text: NOTE }, transient: true }, { type: 'text-delta', id: 't', delta: '好' }, { type: 'finish' }]) c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const got: unknown[] = [];
    const out: string[] = [];
    for await (const t of streamChat(turns, 'aroomo', new AbortController().signal, f, undefined, { conversationId: A, onCompacted: (c) => got.push(c) })) out.push(t);
    expect(got).toEqual([{ keep: 2, text: NOTE }]);
    expect(out.at(-1)).toBe('好');
    expect(sent!.messages).toHaveLength(SEND_MAX_TURNS);
  });
});
