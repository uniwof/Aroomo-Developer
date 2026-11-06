/**
 * #290：所有者「认领」这台浏览器里以前的共用会话（旧的共用键 aroomo.chat.v1）。负责人 #288 裁定：
 * - 只给所有者（Core 确认过的，不认标签页记的）；家人看不到；没有旧会话不显示。
 * - 点之前列出标题和段数；按钮写「这些都是我的，放进我的账号」，她自己点。
 * - 复制不是移走：共用那份保留，只记一笔「已认领」；认领后那句提示不再显示。点两次不重复。
 * - 存库打开时，认领过来的照常导入 Core。
 * #292：问到账号之前先不保存本机会话（不写进共用那份）。
 * 假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { claimLegacy, legacyClaimed, loadConversations, saveConversations, type Conversation } from '@/chat/store';
import { fetchAccount } from '@/lib/api';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false, skeletonShimmer: false }));
vi.mock('@/lib/flags', () => ({ FLAGS: flags }));

const enc = new TextEncoder();
const REPLY = '好的，记下了。';
const sseReply = [
  { type: 'start', messageId: 'm' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: REPLY },
  { type: 'text-end', id: 't' },
  { type: 'finish' },
]
  .map((o) => `data: ${JSON.stringify(o)}\n\n`)
  .join('') + 'data: [DONE]\n\n';
const stream = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(sseReply));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
  );
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OWNER = 'u-owner-1';
const KID = 'u-kid-2';
const MINE = 'cccccccc-0000-4000-8000-000000000001';
const OLD1 = 'cccccccc-0000-4000-8000-000000000003';
const OLD2 = 'cccccccc-0000-4000-8000-000000000004';
const LEGACY = 'aroomo.chat.v1';
const BTN = '这些都是我的，放进我的账号';
const local = (id: string, title: string, at = 2): Conversation => ({ id, title, model: 'aroomo', messages: [{ role: 'user', text: `${title}的问题`, at: 1 }, { role: 'assistant', text: '回答' }], updatedAt: at });
const putLegacy = () => localStorage.setItem(LEGACY, JSON.stringify([local(OLD1, '以前问的体检', 5), local(OLD2, '以前的买菜单', 4)]));

type Me = { kind: 'user'; role: 'admin' | 'user'; id: string } | { kind: 'owner' } | null;
/** me：/api/auth/me 回谁（null = 500）；gate：给了就等它放行再回 me */
function stubCore(me: Me, gate?: Promise<void>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/chat/stream') return stream();
      if (url === '/api/auth/me') {
        if (gate) await gate;
        if (!me) return json({ error: { code: 'X', message: '坏了' } }, 500);
        return me.kind === 'owner' ? json({ kind: 'owner', id: 'owner' }) : json({ kind: 'user', user: { id: me.id, email: 'x@example.test', displayName: '', role: me.role } });
      }
      if (url === '/api/conversations/import') {
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
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('#290 认领以前的共用会话', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = false;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('store：复制进账号那份，共用那份原样；点两次不重复；记一笔已认领', () => {
    putLegacy();
    saveConversations([local(MINE, '我的', 9)], OWNER);
    const before = localStorage.getItem(LEGACY);
    expect(legacyClaimed(OWNER)).toBe(false);
    expect(claimLegacy(OWNER)).toBe(2);
    expect(loadConversations(OWNER).map((c) => c.id)).toEqual([MINE, OLD1, OLD2]);
    expect(localStorage.getItem(LEGACY)).toBe(before);
    expect(legacyClaimed(OWNER)).toBe(true);
    expect(legacyClaimed(KID)).toBe(false);
    expect(claimLegacy(OWNER)).toBe(0);
    expect(loadConversations(OWNER)).toHaveLength(3);
  });

  it('store：同一个 id，共用那份更新（updatedAt 更大）就替换她那份里的这段；不更新就不动', () => {
    saveConversations([local(OLD1, '以前问的体检', 1)], OWNER);
    localStorage.setItem(LEGACY, JSON.stringify([{ ...local(OLD1, '以前问的体检', 9), messages: [...local(OLD1, 'x').messages, { role: 'user', text: '后来又问的' }] }]));
    expect(claimLegacy(OWNER)).toBe(1);
    expect(loadConversations(OWNER)[0]!.messages.map((m) => m.text)).toContain('后来又问的');
    expect(claimLegacy(OWNER)).toBe(0);
    expect(loadConversations(OWNER)).toHaveLength(1);
  });

  it('Core 说谁是所有者：admin 账号和主人令牌是；家人（role=user）不是', async () => {
    const f = (b: unknown) => vi.fn(async () => json(b)) as unknown as typeof fetch;
    expect(await fetchAccount(f({ kind: 'user', user: { id: OWNER, role: 'admin' } }))).toEqual({ id: OWNER, owner: true });
    expect(await fetchAccount(f({ kind: 'user', user: { id: KID, role: 'user' } }))).toEqual({ id: KID, owner: false });
    expect(await fetchAccount(f({ kind: 'owner', id: 'owner' }))).toEqual({ id: 'owner', owner: true });
  });

  it('所有者（本机模式）：先列标题和段数，不点就不动；点了复制一次、读屏播报、提示不再显示', async () => {
    putLegacy();
    saveConversations([local(MINE, '我的', 9)], OWNER);
    const before = localStorage.getItem(LEGACY);
    stubCore({ kind: 'user', role: 'admin', id: OWNER });
    renderPage();
    const btn = await screen.findByRole('button', { name: BTN });
    expect(screen.getByText(/这台浏览器里有 2 段以前的会话/)).toBeInTheDocument();
    const titles = screen.getByRole('list', { name: '以前的会话' });
    expect(titles).toHaveTextContent('以前问的体检');
    expect(titles).toHaveTextContent('以前的买菜单');
    // 不点：她那份里没有，列表里也没有
    await tick();
    expect(loadConversations(OWNER).map((c) => c.id)).toEqual([MINE]);
    expect(screen.getByRole('list', { name: '会话列表' })).not.toHaveTextContent('以前的买菜单');
    fireEvent.click(btn);
    expect((await screen.findByText(/放进你的账号了：2 段会话/)).getAttribute('role')).toBe('status');
    await waitFor(() => expect(screen.getByRole('list', { name: '会话列表' })).toHaveTextContent('以前的买菜单'));
    await tick();
    expect(loadConversations(OWNER).map((c) => c.id).sort()).toEqual([MINE, OLD1, OLD2].sort());
    expect(localStorage.getItem(LEGACY)).toBe(before);
    expect(screen.queryByRole('button', { name: BTN })).toBeNull();
    expect(screen.queryByText(/分不清是哪个账号存的/)).toBeNull();
  });

  it('认领过的：再打开不再显示提示和按钮', async () => {
    putLegacy();
    claimLegacy(OWNER);
    stubCore({ kind: 'user', role: 'admin', id: OWNER });
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    await waitFor(() => expect(list).toHaveTextContent('以前的买菜单'));
    expect(screen.queryByRole('button', { name: BTN })).toBeNull();
    expect(screen.queryByText(/分不清是哪个账号存的/)).toBeNull();
  });

  it('家人看不到按钮和标题', async () => {
    putLegacy();
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id: KID, email: 'k@example.test', displayName: '', role: 'user' }));
    stubCore({ kind: 'user', role: 'user', id: KID });
    renderPage();
    await screen.findByText(/这台浏览器里有 2 段以前的会话/);
    await tick();
    expect(screen.queryByRole('button', { name: BTN })).toBeNull();
    expect(screen.queryByRole('list', { name: '以前的会话' })).toBeNull();
    expect(loadConversations(KID)).toEqual([]);
  });

  it('没有以前的会话：不显示按钮', async () => {
    stubCore({ kind: 'user', role: 'admin', id: OWNER });
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    await tick();
    expect(screen.queryByRole('button', { name: BTN })).toBeNull();
  });

  it('问不到 Core 是谁：不显示按钮（不认标签页记的）', async () => {
    putLegacy();
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id: OWNER, email: 'o@example.test', displayName: '', role: 'owner' }));
    stubCore(null);
    renderPage();
    await screen.findByText(/这台浏览器里有 2 段以前的会话/);
    await tick();
    expect(screen.queryByRole('button', { name: BTN })).toBeNull();
  });

  it('放不下（超过上限）：说「放不下了」，不叫她再点；什么都不记，两份都原样（负责人 #294 必改 2）', async () => {
    putLegacy();
    const many = Array.from({ length: 200 }, (_, i) => local(`cccccccc-0000-4000-8000-1${String(i).padStart(11, '0')}`, `第${i}段`, 100 + i));
    saveConversations(many, OWNER);
    const ids = (k: string | null) => (loadConversations(k).map((c) => c.id).sort() as string[]).join(',');
    const mineBefore = ids(OWNER);
    const before = localStorage.getItem(LEGACY);
    stubCore({ kind: 'user', role: 'admin', id: OWNER });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: BTN }));
    const note = await screen.findByText('放不下了：你账号里的会话太多。原来那份还在，没有丢。请告诉 Hark。');
    expect(note.getAttribute('role')).toBe('alert');
    expect(screen.queryByText(/过一会儿再点/)).toBeNull();
    expect(legacyClaimed(OWNER)).toBe(false);
    await tick();
    expect(ids(OWNER) === mineBefore).toBe(true); // 页面照常保存会重排顺序，比 id 集合
    expect(localStorage.getItem(LEGACY)).toBe(before);
  });

  it('存库打开时：认领过来的照常导入 Core', async () => {
    flags.savedChats = true;
    putLegacy();
    const calls = stubCore({ kind: 'user', role: 'admin', id: OWNER });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: BTN }));
    await waitFor(() => expect(importedIds(calls).sort()).toEqual([OLD1, OLD2].sort()));
    expect(JSON.parse(localStorage.getItem(LEGACY)!)).toHaveLength(2);
  });
});

describe('#292 问到账号之前先不保存本机会话', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = false;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('Core 回得晚：之前新开一段说了一句，回了以后她那份里有新的那段、没有共用那份的旧会话，共用那份原样（负责人 #294 必改 1）', async () => {
    putLegacy();
    const before = localStorage.getItem(LEGACY);
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    stubCore({ kind: 'user', role: 'admin', id: OWNER }, gate);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    fireEvent.click(screen.getAllByRole('button', { name: '新建对话' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /新对话（全员）/ }));
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '帮我记一下明天买药' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(REPLY, undefined, { timeout: 8000 })).toBeInTheDocument();
    await tick();
    expect(localStorage.getItem(LEGACY)).toBe(before);
    open();
    await waitFor(() => expect(loadConversations(OWNER).some((c) => c.messages.some((m) => m.text === '帮我记一下明天买药'))).toBe(true));
    const ids = loadConversations(OWNER).map((c) => c.id);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(OLD1);
    expect(ids).not.toContain(OLD2);
    expect(localStorage.getItem(LEGACY)).toBe(before);
    expect(screen.getByRole('list', { name: '会话列表' })).toHaveTextContent('帮我记一下明天买药');
  });

  it('Core 回得晚：之前在共用那份的旧会话里接着说了一句，这句存回共用那份（不丢），不带进她的账号', async () => {
    putLegacy();
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    stubCore({ kind: 'user', role: 'admin', id: OWNER }, gate);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '接着问体检' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(REPLY, undefined, { timeout: 8000 })).toBeInTheDocument();
    open();
    await waitFor(() => expect(localStorage.getItem(`${LEGACY}:u:${OWNER}`)).not.toBeNull());
    await tick();
    const old = loadConversations().find((c) => c.id === OLD1)!;
    expect(old.messages.map((m) => m.text)).toContain('接着问体检');
    expect(loadConversations()).toHaveLength(2);
    expect(loadConversations(OWNER).map((c) => c.id)).not.toContain(OLD1);
  });

  it('认领过以后：Core 晚回前在旧会话里说的一句存回共用那份，按钮重新出来，点了她那份里这段有这句（负责人 #294 第二轮必改）', async () => {
    putLegacy();
    claimLegacy(OWNER);
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    stubCore({ kind: 'user', role: 'admin', id: OWNER }, gate);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '接着问体检' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(REPLY, undefined, { timeout: 8000 })).toBeInTheDocument();
    open();
    fireEvent.click(await screen.findByRole('button', { name: BTN }));
    await screen.findByText(/放进你的账号了/);
    await tick();
    const mine = loadConversations(OWNER).find((c) => c.id === OLD1)!;
    expect(mine.messages.map((m) => m.text)).toContain('接着问体检');
    expect(loadConversations(OWNER).filter((c) => c.id === OLD1)).toHaveLength(1);
    expect(legacyClaimed(OWNER)).toBe(true);
  });

  it('Core 还没回是谁：不往共用那份写；回了以后写进她自己那份', async () => {
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    stubCore({ kind: 'user', role: 'admin', id: OWNER }, gate);
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    await tick();
    expect(localStorage.getItem(LEGACY)).toBeNull();
    open();
    await waitFor(() => expect(localStorage.getItem(`${LEGACY}:u:${OWNER}`)).not.toBeNull());
    expect(localStorage.getItem(LEGACY)).toBeNull();
  });
});
