/** Poke 行为规范 验收清单 17：资源库里「添加成员」成功后，卡片立刻变成「打开成员」（不用重开面板） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      // 列表接口故意一直慢半拍（还是空）：界面要靠 Core 对 POST 的回答立刻更新
      if (url === '/api/members' && method === 'GET') return json({ members: [] });
      if (url === '/api/members' && method === 'POST')
        return json({ member: { id: 'm9', name: 'Qwen', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false } }, 201);
      if (url === '/api/capabilities') return json({ items: [{ id: 'c2', name: 'Qwen', kind: 'text', provider: '示例', access: 'free' }] });
      if (url === '/api/library') return json({ items: [] });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('清单 17：添加成员后立即刷新', () => {
  it('资源库卡片「添加 Qwen」→ 添加 → 卡片马上变「打开成员 Qwen」', async () => {
    render(
      <MemoryRouter initialEntries={['/hub']}>
        <ChatPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^添加 Qwen/ }, { timeout: 8000 }));
    const dlg = await screen.findByRole('dialog', { name: '添加成员' });
    fireEvent.click(within(dlg).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加成员' })).toBeNull());
    expect(await screen.findByRole('button', { name: /^打开成员 Qwen/ })).toBeInTheDocument();
  }, 20000);
});
