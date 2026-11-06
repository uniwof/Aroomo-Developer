/** F-018（= F-168，D213-9）：第一次进来，全员对话的空状态是负责人的欢迎引导；用过以后照旧 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { newConversation, saveConversations } from '@/chat/store';

const WELCOME = '你好，我是负责人。想做什么，直接在下面说，我来回答，或者交给合适的成员。想找某一位，就 @ 它的名字。';
const USUAL = '所有成员都在。直接说，负责人回答；@ 谁，谁回答。';

describe('第一次进来的欢迎引导（F-018）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const renderPage = () =>
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );

  it('一个会话都没有：负责人欢迎引导，不自动发请求、不写进会话', () => {
    const f = vi.mocked(fetch);
    renderPage();
    expect(screen.getByText(WELCOME)).toBeInTheDocument();
    expect(screen.queryByText(USUAL)).toBeNull();
    expect(screen.getByText('在下面写第一句话')).toBeInTheDocument();
    expect(f.mock.calls.some(([u]) => String(u).includes('/chat'))).toBe(false);
  });

  it('以前说过话（有带消息的会话）：新对话照旧，不再欢迎', () => {
    const old = { ...newConversation(), title: '以前的', messages: [{ id: 'u1', role: 'user' as const, text: '你好' }], updatedAt: Date.now() - 1000 };
    saveConversations([newConversation(), old]);
    renderPage();
    expect(screen.queryByText(WELCOME)).toBeNull();
    expect(screen.getByText(USUAL)).toBeInTheDocument();
  });
});
