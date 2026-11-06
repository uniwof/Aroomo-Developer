/**
 * #296（负责人 #294 建议 2）：问 Core「是谁」（GET /api/auth/me）加 5 秒超时，到时间按「问不到」处理。
 * #292 之后本机模式问到账号前不保存；Core 一直不回时，这段时间说的话不能没地方存（关掉页面就没了）。
 * 超时后存到标签页记的那份 / 共用那份（同「问不到」）。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { claimLegacy, legacyClaimed, loadConversations } from '@/chat/store';
import { fetchAccount } from '@/lib/api';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false, skeletonShimmer: false }));
vi.mock('@/lib/flags', () => ({ FLAGS: flags }));

const enc = new TextEncoder();
const REPLY = '好的，记下了。';
const sseReply =
  [{ type: 'start', messageId: 'm' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: REPLY }, { type: 'text-end', id: 't' }, { type: 'finish' }]
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
const never = new Promise<Response>(() => {});
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('#296 问「是谁」超时', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fetchAccount：Core 不回，到时间返回 null（按问不到）', async () => {
    const f = vi.fn(() => never) as unknown as typeof fetch;
    expect(await Promise.race([fetchAccount(f, 50), tick(500).then(() => 'hung')])).toBeNull();
  });

  it('fetchAccount：Core 按时回，照常', async () => {
    const f = vi.fn(async () => json({ kind: 'owner', id: 'owner' })) as unknown as typeof fetch;
    expect(await fetchAccount(f, 1000)).toEqual({ id: 'owner', owner: true });
  });

  it('本机模式：Core 一直不回是谁，5 秒后说过的话照样存下来（共用那份）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/members') return json({ members: [] });
        if (url === '/api/chat/stream') return stream();
        if (url === '/api/auth/me') return never;
        return json({}, 404);
      }),
    );
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    await screen.findByRole('list', { name: '会话列表' });
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '帮我记一下明天买药' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(REPLY, undefined, { timeout: 8000 })).toBeInTheDocument();
    await waitFor(() => expect(loadConversations().some((c) => c.messages.some((m) => m.text === '帮我记一下明天买药'))).toBe(true), { timeout: 8000 });
  }, 15000);
  it('认领过以后：Core 超时，在旧会话里说的一句存回共用那份；下次打开 Core 按时回，按钮重新出来，点了她那份里有这句（负责人 #298 必改）', async () => {
    const OWNER = 'u-owner-1';
    const OLD1 = 'cccccccc-0000-4000-8000-000000000003';
    const old = { id: OLD1, title: '以前问的体检', model: 'aroomo', messages: [{ role: 'user', text: '体检要空腹吗', at: 1 }, { role: 'assistant', text: '要' }], updatedAt: 5 };
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([old]));
    claimLegacy(OWNER);
    let answer = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/members') return json({ members: [] });
        if (url === '/api/chat/stream') return stream();
        if (url === '/api/auth/me') return answer ? json({ kind: 'user', ownerAccount: true, user: { id: OWNER, email: 'o@example.test', displayName: '', role: 'admin' } }) : never;
        return json({}, 404);
      }),
    );
    const first = render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    await screen.findByRole('list', { name: '会话列表' });
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '接着问体检' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(REPLY, undefined, { timeout: 8000 })).toBeInTheDocument();
    await waitFor(() => expect(loadConversations().find((c) => c.id === OLD1)!.messages.map((m) => m.text)).toContain('接着问体检'), { timeout: 8000 });
    first.unmount();

    answer = true;
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '这些都是我的，放进我的账号' }, { timeout: 4000 }));
    await screen.findByText(/放进你的账号了/);
    expect(loadConversations(OWNER).find((c) => c.id === OLD1)!.messages.map((m) => m.text)).toContain('接着问体检');
    expect(legacyClaimed(OWNER)).toBe(true);
  }, 20000);
});
