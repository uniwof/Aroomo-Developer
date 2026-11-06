/**
 * 方案 v2.2 阶段 3「会话存库，浏览器里的会话可以一键导入 Core」（FLAGS.savedChats）。
 * 打开页面时自动导入一次照旧；没导进去的（自动那次失败、或之后又多了本机会话），会话列表上方给一行说明 + 一个「导入」按钮，
 * 点一下就导，结果读屏能听到。家人账号、全部导入过的、没开存库的都不显示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { importedKey, localPending } from '@/chat/saved';
import { saveConversations, type Conversation } from '@/chat/store';
vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: true, skeletonShimmer: false } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const L1 = 'cccccccc-0000-4000-8000-000000000003';
/** #287：本机会话按账号分开存，导入前 Core 确认是谁 */
const OWNER = 'u-owner-1';
const mine = (list: Conversation[]) => saveConversations(list, OWNER);
const L2 = 'cccccccc-0000-4000-8000-000000000004';
const row = (id: string, title: string) => ({
  id,
  title,
  model: 'aroomo',
  group: [],
  archived: false,
  unread: false,
  running: false,
  messageCount: 2,
  last: { role: 'assistant', preview: `${title}的回复`, createdAt: 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)' },
  readAt: null,
  createdAt: 'Thu 2026-11-05 1:00 PM CST (UTC+08:00)',
  updatedAt: 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)',
});
const local = (id: string, title: string): Conversation => ({ id, title, model: 'aroomo', messages: [{ role: 'user', text: `${title}的问题`, at: 1 }, { role: 'assistant', text: '回答' }], updatedAt: 2 });

/** importFails：前几次 POST /api/conversations/import 返回 503 */
function stubCore(importFails = 0) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let imported: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/auth/me') return json({ kind: 'user', user: { id: OWNER, email: 'o@example.test', role: 'owner' } });
      if (url === '/api/conversations/import') {
        if (importFails-- > 0) return json({ error: { code: 'X', message: '坏了' } }, 503);
        const cs = (body as { conversations: Array<{ id: string; title: string }> }).conversations;
        imported = [...imported, ...cs.map((c) => c.id)];
        return json({ imported: cs.length, skipped: 0, ids: {} });
      }
      if (url.startsWith('/api/conversations?'))
        return json({ conversations: [row(A, '周末去哪'), ...imported.map((id) => row(id, id === L1 ? '本机一' : '本机二'))], nextCursor: null });
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

describe('一键导入本机会话', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id: OWNER, email: 'o@example.test', displayName: '', role: 'owner' }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('打开时自动导入失败：列表上方说还有几段没导入，点「导入」一次导进去，读屏听到结果，列表里出现它们', async () => {
    mine([local(L1, '本机一'), local(L2, '本机二')]);
    const calls = stubCore(1);
    renderPage();
    expect(await screen.findByText('这台浏览器里还有 2 段会话没存到 Aroomo。')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: '导入这 2 段会话' });
    fireEvent.click(btn);
    expect(await screen.findByText('导入好了 2 段会话。')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: /导入这/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem(importedKey(OWNER))!)).toEqual([L1, L2]);
    expect(calls.filter((c) => c.url === '/api/conversations/import')).toHaveLength(2);
    // 导完重新取一次列表：导入的会话出现在会话列表里
    await waitFor(() => expect(screen.getByRole('list', { name: '会话列表' })).toHaveTextContent('本机二'));
  });

  it('点了还是没导进去：说一句没成功、按钮还在，可以再点', async () => {
    mine([local(L1, '本机一')]);
    stubCore(2);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '导入这 1 段会话' }));
    expect(await screen.findByText('没导进去，本机那份还在。过一会儿再点一次。')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: '导入这 1 段会话' })).toBeEnabled();
    expect(localStorage.getItem(importedKey(OWNER))).toBeNull();
  });

  it('自动导入成功、全部导入过、或只有空会话：不显示', async () => {
    mine([local(L1, '本机一'), { id: L2, title: '空的', model: 'aroomo', messages: [], updatedAt: 3 }]);
    const calls = stubCore(0);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/conversations/import')).toBe(true));
    await waitFor(() => expect(screen.getByRole('list', { name: '会话列表' })).toHaveTextContent('本机一'));
    expect(screen.queryByText(/段会话没存到/)).toBeNull();
  });

  it('家人账号：本机会话是所有者的，不导入也不显示', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id: 'u-kid-2', email: 'kid@example.com', displayName: '小号', role: 'user' }));
    mine([local(L1, '本机一')]);
    const calls = stubCore(5);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    expect(screen.queryByText(/段会话没存到/)).toBeNull();
    expect(calls.some((c) => c.url === '/api/conversations/import')).toBe(false);
  });

  it('localPending：只数有消息、还没导入过的本机会话', () => {
    const store = new Map<string, string>([[importedKey(OWNER), JSON.stringify([L1])]]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    saveConversations([local(L1, '一'), local(L2, '二'), { id: 'x', title: '空', model: 'aroomo', messages: [], updatedAt: 1 }], OWNER, storage);
    expect(localPending(OWNER, storage)).toBe(1);
  });
});
