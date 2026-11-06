/**
 * #296（负责人 #294 建议 2）：问 Core「是谁」（GET /api/auth/me）加 5 秒超时，到时间按「问不到」处理。
 * #292 之后本机模式问到账号前不保存；Core 一直不回时，这段时间说的话不能没地方存（关掉页面就没了）。
 * 超时后存到标签页记的那份 / 共用那份（同「问不到」）。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { loadConversations } from '@/chat/store';
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
});
