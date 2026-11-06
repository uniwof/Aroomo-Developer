/** Poke 行为规范 切片 7：全局兜底（审计 G1 错误边界、C10 旧回复重试先确认） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatPage } from '@/chat/ChatPage';
// 这组测试测的是阶段 2/3 开关打开后的行为（以后验收、打开时用）。阶段 1.5 发布默认全关，关着的样子见 release-15-flags-off.test.tsx
vi.mock('@/lib/flags', () => ({ TASK_CARDS: true, QUICK_REPLIES: false, CONV_FILTER: true, SCHEDULE_PAGE: true, ASSISTANT_DRAFT: true, ASSISTANTS: true, SAVED_CHATS: true, SKELETON_SHIMMER: false }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Boom(): never {
  throw new Error('假错误');
}

describe('切片 7：兜底', () => {
  it('面板渲染出错：不白屏，显示一句话和「回到对话」', () => {
    const onReset = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary onReset={onReset}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('这一页出错了');
    fireEvent.click(screen.getByRole('button', { name: '回到对话' }));
    expect(onReset).toHaveBeenCalled();
  });

  it('旧回复上的「重试」会删掉后面的对话：先确认，取消就什么都不变', async () => {
    localStorage.setItem(
      'aroomo.chat.v1',
      JSON.stringify([
        {
          id: 'c1',
          title: '旧话题',
          model: 'aroomo',
          messages: [
            { role: 'user', text: '第一问' },
            { role: 'assistant', text: '第一答' },
            { role: 'user', text: '第二问' },
            { role: 'assistant', text: '第二答' },
          ],
          updatedAt: 1,
        },
      ]),
    );
    const chatFetch = vi.fn() as unknown as typeof fetch;
    render(
      <MemoryRouter>
        <ChatPage fetchImpl={chatFetch} />
      </MemoryRouter>,
    );
    const retries = await screen.findAllByRole('button', { name: '重试，重新回答这条' });
    fireEvent.click(retries[0]!);
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('后面的 2 条消息会被删掉');
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(chatFetch).not.toHaveBeenCalled();
    expect(within(screen.getByRole('log', { name: '对话内容' })).getByText('第二答')).toBeInTheDocument();
  });
});
