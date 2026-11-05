/** Poke 行为规范 切片 2：面板进地址栏，直接打开、刷新、前进后退都对（审计 C3 C4 S1） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { App } from '@/App';

const MEMBERS = [{ id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }];
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.session', 'cookie-session');
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: MEMBERS });
      if (url.startsWith('/api/audit')) return json({ entries: [], nextCursor: null });
      if (url === '/api/keys') return json({ keys: [] });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

let nav: NavigateFunction;
let where = '';
function Probe() {
  nav = useNavigate();
  where = useLocation().pathname + useLocation().search;
  return null;
}
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Probe />
    </MemoryRouter>,
  );
const mainTitle = () => within(screen.getByRole('main')).getAllByRole('heading', { level: 1 })[0]!.textContent;

describe('切片 2：路由', () => {
  it.each([
    ['/team', '成员'],
    ['/hub', '资源库'],
    ['/hub/tools', '工具'],
    ['/hub/keys', 'API'],
    ['/inbox', '收件箱'],
    ['/settings/audit', '审计记录'],
  ])('直接打开 %s → %s', { timeout: 20000 }, async (path, title) => {
    at(path);
    await waitFor(() => expect(mainTitle()).toBe(title), { timeout: 15000 });
    expect(where).toBe(path);
  });

  it('旧地址重定向到新地址', async () => {
    at('/members');
    await waitFor(() => expect(where).toBe('/team'));
    cleanup();
    at('/chat?view=keys');
    await waitFor(() => expect(where).toBe('/hub/keys'));
  });

  it('点面板进历史；浏览器后退回到上一个面板，前进再回来', async () => {
    at('/chat');
    await screen.findByLabelText('输入消息');
    fireEvent.click(within(screen.getByRole('navigation', { name: '分类' })).getByRole('button', { name: '成员' }));
    await waitFor(() => expect(where).toBe('/team'));
    expect(mainTitle()).toBe('成员');
    act(() => nav(-1));
    await waitFor(() => expect(where).toBe('/chat'));
    expect(screen.getByLabelText('输入消息')).toBeVisible();
    act(() => nav(1));
    await waitFor(() => expect(mainTitle()).toBe('成员'));
  });

  it('桌面：/settings/safety 打开设置弹窗的「安全」；审计「← 设置」回到设置，关掉后不再停在审计页', async () => {
    at('/settings/audit');
    await waitFor(() => expect(mainTitle()).toBe('审计记录'));
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
    await waitFor(() => expect(where).toBe('/settings/safety'));
    const dlg = document.querySelector('dialog[open]') as HTMLElement;
    expect(within(dlg).getByRole('heading', { name: '安全' })).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: '关闭设置' }));
    await waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
    expect(where).not.toMatch(/audit/);
    expect(screen.queryByRole('heading', { name: '审计记录' })).toBeNull();
  });
});
