/** Poke 行为规范 切片 12（审计 C11）：家人账号不显示空的「助手」分段（点了只有空列表，是死点击） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
// 所有者的「助手」分段要助手开关打开（阶段 2/3 验收时）；阶段 1.5 发布默认关、没有分段，见 release-15-flags-off.test.tsx
vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false } }));

const asRole = (role: string) => sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'a@example.test', displayName: '测试', role }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
const at = () =>
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <ChatPage />
    </MemoryRouter>,
  );

describe('切片 12：家人不显示空的「助手」', () => {
  it('家人账号：会话栏没有「对话 / 助手」分段，只有会话列表', async () => {
    asRole('user');
    at();
    await screen.findByRole('list', { name: '会话列表' }).catch(() => screen.findByText('还没有会话。'));
    expect(screen.queryByRole('radio', { name: '助手' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '列表' })).toBeNull();
  });

  it('所有者账号照旧有「助手」分段', async () => {
    asRole('owner');
    at();
    expect(await screen.findByRole('radio', { name: '助手' })).toBeInTheDocument();
  });
});
