/** Poke 行为规范 切片 5：成员与资产分开（审计 M1 M2 M3 H1 H2） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const M = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, ...extra });
let members: unknown[] = [];
let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members });
      if (url === '/api/capabilities') return json({ items: [{ id: 'c1', name: 'Kimi', kind: 'text', provider: '示例', access: 'free' }, { id: 'c2', name: 'Qwen', kind: 'text', provider: '示例', access: 'free' }] });
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
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
      <Probe />
    </MemoryRouter>,
  );

describe('切片 5：成员与资产', () => {
  it('成员页列出全部：在职、候选、已停用分组，候选和停用也能点开', async () => {
    members = [M('m1', 'Kimi'), M('m2', '候选甲', { status: 'candidate' }), M('m3', '停用乙', { enabled: false })];
    at('/team');
    const main = screen.getByRole('main');
    await within(main).findByRole('button', { name: /候选甲/ });
    expect(within(main).getByRole('region', { name: '在职（1）' })).toBeInTheDocument();
    expect(within(main).getByRole('region', { name: '候选（1）' })).toBeInTheDocument();
    expect(within(main).getByRole('region', { name: '已停用（1）' })).toBeInTheDocument();
    fireEvent.click(within(main).getByRole('button', { name: /停用乙/ }));
    await waitFor(() => expect(where).toBe('/team?member=m3'));
    expect(within(screen.getByRole('main')).getByText('停用乙', { selector: '.profile-name' })).toBeInTheDocument();
  });

  it('成员页空状态的动作直达「添加成员」', async () => {
    members = [];
    at('/team');
    fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: '添加成员' }));
    expect(await screen.findByRole('heading', { name: '添加成员' })).toBeInTheDocument();
  });

  it('能力地图属于资源库（/hub/capabilities），返回回资源库', async () => {
    members = [M('m1', 'Kimi')];
    at('/hub/capabilities');
    await waitFor(() => expect(within(screen.getByRole('main')).getAllByRole('heading', { level: 1 })[0]).toHaveTextContent('能力地图'));
    fireEvent.click(screen.getByRole('button', { name: '返回资源库' }));
    await waitFor(() => expect(where).toBe('/hub'));
  });

  it('资源库里已经是成员的模型：点卡片打开这位成员，不再重复添加', async () => {
    members = [M('m1', 'Kimi')];
    at('/hub');
    const card = await screen.findByRole('button', { name: /^打开成员 Kimi/ }, { timeout: 8000 });
    fireEvent.click(card);
    await waitFor(() => expect(where).toBe('/team?member=m1'));
    expect(screen.queryByRole('heading', { name: '添加成员' })).toBeNull();
    // 还不是成员的照旧是「添加」
    cleanup();
    at('/hub');
    expect(await screen.findByRole('button', { name: /^添加 Qwen/ }, { timeout: 8000 })).toBeInTheDocument();
  }, 20000);
});
