/** Poke 行为规范 切片 10（审计 S4）：收件箱、审计、电脑助手嵌在面板里时，整页只有一个一级标题（面板顶栏那个） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      if (url.startsWith('/api/inbox')) return json({ groups: {} });
      if (url.startsWith('/api/audit')) return json({ entries: [], nextCursor: null });
      if (url === '/api/clients') return json({ clients: [] });
      if (url === '/api/executors') return json({ executors: [] });
      if (url === '/api/tasks') return json({ tasks: [] });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('切片 10：一个一级标题', () => {
  it.each([
    ['/inbox', '收件箱', '收件箱'],
    ['/settings/audit', '审计记录', '审计'],
    ['/settings/executors', '电脑助手', '电脑助手'],
  ])('%s：只有面板顶栏一个 h1，页面自己的标题降为 h2', async (path, h1, h2) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <ChatPage />
      </MemoryRouter>,
    );
    const main = screen.getByRole('main');
    await within(main).findByRole('heading', { level: 2, name: h2 }, { timeout: 8000 });
    await waitFor(() => expect(within(main).getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([h1]));
  }, 20000);
});
