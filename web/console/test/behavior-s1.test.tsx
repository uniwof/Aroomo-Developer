/** Poke 行为规范 切片 1：对话不丢（审计 C1）、点名不重复不串会话（C2） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { loadConversations } from '@/chat/store';

const enc = new TextEncoder();
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const MEMBERS = [{ id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return new Response(JSON.stringify({ members: MEMBERS }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = (fetchImpl?: typeof fetch) =>
  render(
    <MemoryRouter>
      <ChatPage {...(fetchImpl ? { fetchImpl } : {})} />
    </MemoryRouter>,
  );
const rail = () => within(screen.getByRole('navigation', { name: '分类' }));

describe('切片 1：对话不丢', () => {
  it('回复进行中打开「成员」面板：那句话立即存下，回复照常收完，回到对话都在', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chatFetch = (async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode(ev({ type: 'text-delta', delta: '第一段' })));
            await gate;
            c.enqueue(enc.encode(ev({ type: 'text-delta', delta: '，第二段' }) + 'data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch;
    page(chatFetch);
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '测试消息一' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('第一段')).toBeInTheDocument(), { timeout: 8000 });
    fireEvent.click(rail().getByRole('button', { name: '成员' }));
    // 用户那句话发出时就已存下
    await waitFor(() => expect(loadConversations()[0]?.messages[0]?.text).toBe('测试消息一'));
    release();
    await waitFor(() => expect(loadConversations()[0]?.messages.map((m) => m.text)).toEqual(['测试消息一', '第一段，第二段']));
    fireEvent.click(rail().getByRole('button', { name: '对话' }));
    const log = within(screen.getByRole('log', { name: '对话内容' }));
    expect(log.getByText('测试消息一')).toBeInTheDocument();
    await waitFor(() => expect(log.getByText(/第二段/)).toBeInTheDocument(), { timeout: 8000 });
  }, 20000);

  it('「在当前对话里点名」只插一次；离开再回来不重复；新对话不带过去', async () => {
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([{ id: 'c1', title: '旧话题', model: 'aroomo', messages: [{ role: 'user', text: '旧的一句' }], updatedAt: 1 }]));
    page();
    fireEvent.click(rail().getByRole('button', { name: '成员' }));
    fireEvent.click(await screen.findByRole('button', { name: /Kimi/ }));
    fireEvent.click(screen.getByRole('button', { name: '在当前对话里点名 Kimi' }));
    await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('@Kimi '));
    fireEvent.click(rail().getByRole('button', { name: '成员' }));
    fireEvent.click(rail().getByRole('button', { name: '对话' }));
    expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('@Kimi ');
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe(''));
  }, 20000);
});
