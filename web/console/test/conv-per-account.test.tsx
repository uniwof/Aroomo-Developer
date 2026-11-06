/**
 * #287：本机会话按账号分开记；导入只导当前账号自己存的。
 * - 以前所有账号共用一个 `aroomo.chat.v1`：家人在所有者设备上用过对话页，所有者打开时会被导进所有者的账号。
 * - 现在按账号 id 分键存；旧的共用那份看不出是谁的，不导入、不删，只说一句。
 * - 账号以 Core 的 GET /api/auth/me 为准；问不到就不导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { localPending } from '@/chat/saved';
import { loadConversations, saveConversations, type Conversation } from '@/chat/store';
import { currentUser, login } from '@/lib/api';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: true, skeletonShimmer: false }));
vi.mock('@/lib/flags', () => ({ FLAGS: flags }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OWNER = 'u-owner-1';
const KID = 'u-kid-2';
const MINE = 'cccccccc-0000-4000-8000-000000000001';
const KIDS = 'cccccccc-0000-4000-8000-000000000002';
const OLD = 'cccccccc-0000-4000-8000-000000000003';
const local = (id: string, title: string): Conversation => ({ id, title, model: 'aroomo', messages: [{ role: 'user', text: `${title}的问题`, at: 1 }, { role: 'assistant', text: '回答' }], updatedAt: 2 });
const asOwner = () => sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id: OWNER, email: 'o@example.test', displayName: '', role: 'owner' }));

/** me：/api/auth/me 回谁（null = 500）；importFails：前几次导入返回 503 */
function stubCore(me: string | null, importFails = 0) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/auth/me') return me ? json({ kind: 'user', user: { id: me, email: 'o@example.test', role: 'owner' } }) : json({ error: { code: 'X', message: '坏了' } }, 500);
      if (url === '/api/conversations/import') {
        if (importFails-- > 0) return json({ error: { code: 'X', message: '坏了' } }, 503);
        const cs = (body as { conversations: unknown[] }).conversations;
        return json({ imported: cs.length, skipped: 0, ids: {} });
      }
      if (url.startsWith('/api/conversations?')) return json({ conversations: [], nextCursor: null });
      return json({}, 404);
    }),
  );
  return calls;
}
const importedIds = (calls: Array<{ url: string; body: unknown }>) =>
  calls.filter((c) => c.url === '/api/conversations/import').flatMap((c) => (c.body as { conversations: Array<{ id: string }> }).conversations.map((x) => x.id));

const renderPage = () =>
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );

describe('#287 本机会话按账号分开', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = true;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('存取按账号分开：A 存的 B 读不到，旧的共用键也读不到', () => {
    saveConversations([local(MINE, '我的')], OWNER);
    expect(loadConversations(OWNER).map((c) => c.id)).toEqual([MINE]);
    expect(loadConversations(KID)).toEqual([]);
    expect(loadConversations()).toEqual([]);
    expect(localStorage.getItem('aroomo.chat.v1')).toBeNull();
  });

  it('所有者打开：只导她自己存的；家人存的、旧的共用那份都不导、不计数，旧的那份不删，说一句', async () => {
    asOwner();
    saveConversations([local(MINE, '我的')], OWNER);
    saveConversations([local(KIDS, '孩子的')], KID);
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([local(OLD, '以前的')]));
    const before = localStorage.getItem('aroomo.chat.v1');
    const calls = stubCore(OWNER);
    renderPage();
    await waitFor(() => expect(importedIds(calls)).toEqual([MINE]));
    expect(await screen.findByText('这台浏览器里有 1 段以前的会话，分不清是哪个账号存的，没有导入，也没有删。')).toBeInTheDocument();
    expect(screen.queryByText(/段会话没存到/)).toBeNull();
    expect(localStorage.getItem('aroomo.chat.v1')).toBe(before);
    expect(localPending(KID)).toBe(1);
  });

  it('自动导入失败：「还有 N 段没导入」只数当前账号的', async () => {
    asOwner();
    saveConversations([local(MINE, '我的')], OWNER);
    saveConversations([local(KIDS, '孩子的')], KID);
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([local(OLD, '以前的'), local(KIDS.replace('2', '9'), '更早的')]));
    stubCore(OWNER, 1);
    renderPage();
    expect(await screen.findByText('这台浏览器里还有 1 段会话没存到 Aroomo。')).toBeInTheDocument();
  });

  it('以 Core 说的账号为准：页面记的账号和 Core 的不一样，按 Core 的导', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id: KID, email: 'k@example.test', displayName: '', role: 'owner' }));
    saveConversations([local(MINE, '我的')], OWNER);
    saveConversations([local(KIDS, '孩子的')], KID);
    const calls = stubCore(OWNER);
    renderPage();
    await waitFor(() => expect(importedIds(calls)).toEqual([MINE]));
  });

  it('问不到 Core 是谁：什么都不导入，列表照常', async () => {
    asOwner();
    saveConversations([local(MINE, '我的')], OWNER);
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([local(OLD, '以前的')]));
    const calls = stubCore(null);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/conversations?'))).toBe(true));
    expect(calls.some((c) => c.url === '/api/conversations/import')).toBe(false);
  });

  it('本机模式（存库关着）：知道是谁就写进这个账号自己的那份，不写共用键；旧的不显示在列表里，说一句', async () => {
    flags.savedChats = false;
    asOwner();
    saveConversations([local(MINE, '我的')], OWNER);
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([local(OLD, '以前的')]));
    stubCore(OWNER);
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    expect(list).toHaveTextContent('我的');
    expect(list).not.toHaveTextContent('以前的');
    expect(screen.getByText('这台浏览器里有 1 段以前的会话，分不清是哪个账号存的，没有导入，也没有删。')).toBeInTheDocument();
    await waitFor(() => expect(loadConversations(OWNER).map((c) => c.id)).toEqual([MINE]));
    expect(JSON.parse(localStorage.getItem('aroomo.chat.v1')!)).toHaveLength(1);
  });

  it('本机模式：已登录但这个标签页没记 id（新标签页 / 从 Shell 进来）：问 Core，读她自己那份，不读共用那份（#288 必改 1）', async () => {
    flags.savedChats = false;
    saveConversations([local(MINE, '我的')], OWNER);
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([local(OLD, '以前的')]));
    stubCore(OWNER);
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    await waitFor(() => expect(list).toHaveTextContent('我的'));
    expect(list).not.toHaveTextContent('以前的');
  });

  it('本机模式：一开始不知道账号、读了共用那份，问到账号后她自己那份里不能出现共用那份的会话（#288 必改 2）', async () => {
    flags.savedChats = false;
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([local(OLD, '以前的')]));
    stubCore(OWNER);
    renderPage();
    await screen.findByText('这台浏览器里有 1 段以前的会话，分不清是哪个账号存的，没有导入，也没有删。');
    await new Promise((r) => setTimeout(r, 50));
    expect(loadConversations(OWNER).map((c) => c.id)).not.toContain(OLD);
    expect(loadConversations().map((c) => c.id)).toEqual([OLD]);
  });

  it('从 Shell 打开：Core 回的是主人令牌（kind=owner），当作所有者那份，不回到共用那份', async () => {
    const f = vi.fn(async () => json({ kind: 'owner', id: 'owner' }));
    const { fetchAccountId } = await import('@/lib/api');
    expect(await fetchAccountId(f as unknown as typeof fetch)).toBe('owner');
  });

  it('登录时记下账号 id', async () => {
    const f = vi.fn(async () => json({ user: { id: OWNER, email: 'o@example.test', role: 'owner' } }));
    await login('o@example.test', 'pw', f as unknown as typeof fetch);
    expect(currentUser()?.id).toBe(OWNER);
  });
});
