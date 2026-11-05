/** Poke 行为规范 切片 4：搜索框回车/↓（审计 C7）、单聊不弹 @（C8）、输入框 /路由（G2，规范 §3 Omnibox） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const MEMBERS = [
  { id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true },
  { id: 'm2', name: 'Qwen', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false },
];
let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url === '/api/members' ? new Response(JSON.stringify({ members: MEMBERS }), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 }))),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const page = (fetchImpl?: typeof fetch) =>
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <ChatPage {...(fetchImpl ? { fetchImpl } : {})} />
      <Probe />
    </MemoryRouter>,
  );
const box = () => screen.getByLabelText('输入消息') as HTMLTextAreaElement;

describe('切片 4：搜索框与输入框', () => {
  it('会话栏搜索：回车打开第一条结果；↓ 把焦点移到第一条', async () => {
    localStorage.setItem(
      'aroomo.chat.v1',
      JSON.stringify([
        { id: 'c1', title: '天气', model: 'aroomo', messages: [{ role: 'user', text: '天气' }], updatedAt: 2 },
        { id: 'c2', title: '买菜清单', model: 'aroomo', messages: [{ role: 'user', text: '买菜清单' }], updatedAt: 1 },
      ]),
    );
    page();
    const s = screen.getByRole('searchbox', { name: '搜索对话' });
    fireEvent.change(s, { target: { value: '买菜' } });
    fireEvent.keyDown(s, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^买菜清单/);
    fireEvent.keyDown(s, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /全员/ })).toBeInTheDocument());
    expect(within(screen.getByRole('button', { name: /话题：买菜清单/ })).getByText('买菜清单')).toBeInTheDocument();
  });

  it('单独对话里输入 @ 不弹成员列表（只会发给这一位）', async () => {
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([{ id: 'c1', title: '和 Kimi', model: 'aroomo/m1', messages: [{ role: 'user', text: '你好' }], updatedAt: 1 }]));
    page();
    await screen.findByRole('heading', { level: 1, name: /Kimi/ });
    fireEvent.change(box(), { target: { value: '@' } });
    expect(screen.queryByRole('listbox', { name: '点名一位成员' })).toBeNull();
  });

  it('输入 /te 弹出「前往」建议，回车导航到 /team，输入框清空，不发消息', async () => {
    const chatFetch = vi.fn() as unknown as typeof fetch;
    page(chatFetch);
    fireEvent.change(box(), { target: { value: '/te' } });
    const list = await screen.findByRole('listbox', { name: '前往页面' });
    expect(within(list).getByRole('option', { name: /成员/ })).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(where).toBe('/team'));
    expect(chatFetch).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('navigation', { name: '分类' })).getByRole('button', { name: '对话' }));
    expect(box().value).toBe('');
  });

  it('不认得的 /xyz 不弹建议，照常当一句话（不吞掉）', async () => {
    page();
    fireEvent.change(box(), { target: { value: '/xyz' } });
    expect(screen.queryByRole('listbox', { name: '前往页面' })).toBeNull();
  });
});
