/** Poke 行为规范 切片 9（审计 C12）：从 Shell 打开时，「对话要直接打开 Aroomo 网页」只在对话请求真的失败（401/403/404）时出现 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const BANNER = /对话要直接打开 Aroomo 网页才能用/;
beforeEach(() => {
  localStorage.clear();
  const m = document.createElement('meta');
  m.name = 'aroomo-shell';
  document.head.appendChild(m);
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  document.head.querySelector('meta[name="aroomo-shell"]')?.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function open(status: number) {
  const { ChatPage } = await import('@/chat/ChatPage');
  const chatFetch = vi.fn(async () =>
    status === 200
      ? new Response('data: {"type":"text-delta","delta":"好"}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify({ error: { message: '没登录' } }), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <ChatPage fetchImpl={chatFetch} />
    </MemoryRouter>,
  );
  return chatFetch;
}
async function send(text: string) {
  fireEvent.change(await screen.findByLabelText('输入消息'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
}

describe('切片 9：Shell 横幅只在失败时出现', () => {
  it('从 Shell 打开、还没发消息：不显示横幅', async () => {
    await open(200);
    await screen.findByLabelText('输入消息');
    expect(screen.queryByText(BANNER)).toBeNull();
  }, 30000);

  it('对话请求成功：不显示横幅', async () => {
    const f = await open(200);
    await send('你好');
    await waitFor(() => expect(f).toHaveBeenCalled());
    await screen.findByText('好');
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it.each([401, 404])('对话请求回 %i：显示横幅', async (status) => {
    await open(status);
    await send('你好');
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
  });

  it('其他错误（500）不显示横幅，只在消息里说', async () => {
    await open(500);
    await send('你好');
    await screen.findAllByText('没登录');
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});
