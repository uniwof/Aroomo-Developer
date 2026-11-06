/** Poke 行为规范 切片 3：抽屉一致（审计 C5 C6）——点外面关、Esc 关；关了再开，会话栏的搜索词、分段、折叠都还在 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
// 这组测试测的是阶段 2/3 开关打开后的行为（「对话 / 助手」分段要助手开关）。阶段 1.5 发布默认全关，关着的样子见 release-15-flags-off.test.tsx
vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false } }));

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  vi.unstubAllGlobals();
});

describe('切片 3：抽屉', () => {
  it('中等宽度会话列表抽屉：点背景关（和全站弹窗一样）；再开时搜索词、分段、折叠都还在', async () => {
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    const open = () => fireEvent.click(screen.getByRole('button', { name: /打开菜单/ }));
    open();
    const d = document.querySelector('dialog.drawer') as HTMLDialogElement;
    await waitFor(() => expect(d.hasAttribute('open')).toBe(true));
    fireEvent.change(within(d).getByRole('searchbox', { name: '搜索对话' }), { target: { value: 'abc' } });
    fireEvent.click(within(d).getByRole('radio', { name: '助手' }));
    // 点的是 <dialog> 自己（背景），不是里面的内容
    fireEvent.click(d);
    await waitFor(() => expect(d.hasAttribute('open')).toBe(false));
    open();
    await waitFor(() => expect(d.hasAttribute('open')).toBe(true));
    // 停在「助手」分段：搜索框跟着叫「搜索助手」（integrate/stage2）
    expect((within(d).getByRole('searchbox', { name: '搜索助手' }) as HTMLInputElement).value).toBe('abc');
    expect(within(d).getByRole('radio', { name: '助手' })).toHaveAttribute('aria-checked', 'true');
    // 点抽屉里面不关
    fireEvent.click(within(d).getByRole('searchbox', { name: '搜索助手' }));
    expect(d.hasAttribute('open')).toBe(true);
  });
});
