/** #300 负责人必改：点开才下载的部分下载失败（重新部署后旧分包没了）时，只在那里说一句 + 「刷新」，对话页其余部分照常，不整页白屏。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { SettingsSectionBody } from '@/chat/panels';
import { loadPrefs } from '@/chat/store';

// 模拟分包下载失败：import() 这两个模块一律报错
vi.mock('@/chat/push-section', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
vi.mock('@/components/ClientTokens', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      if (url.startsWith('/api/inbox')) return json({ groups: {} });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>,
  );
}

describe('#300 点开才下载的部分下载失败', () => {
  it('设置 › 外部接入：连接密码那块说「没加载出来」+「刷新」（点了整页刷新）；设置分组、对话列表、输入框都还在', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    at('/settings/external');
    const alert = await screen.findByRole('alert', {}, { timeout: 8000 });
    expect(alert.textContent).toContain('没加载出来。刷新一下页面再点。');
    fireEvent.click(within(alert).getByRole('button', { name: '刷新' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // 不是整页白屏：设置弹窗的分区导航、底下对话页的会话搜索和输入框都在
    expect(within(screen.getByRole('list', { name: '设置分组' })).getByRole('button', { name: /偏好/ })).toBeTruthy();
    expect(screen.getByLabelText('输入消息')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: '找对话' })).toBeTruthy();
  }, 20000);

  it('资源库 › 外部接入（/hub/mcp）：同样只在连接密码那块说一句，不是整面板出错', async () => {
    at('/hub/mcp');
    const alert = await screen.findByRole('alert', {}, { timeout: 8000 });
    expect(alert.textContent).toContain('没加载出来');
    expect(screen.getByRole('main').textContent).not.toContain('这一页出错了');
  }, 20000);

  it('设置 › 推送提醒：说「没加载出来」+「刷新」，分区标题照常', async () => {
    render(<SettingsSectionBody section="push" prefs={loadPrefs()} setPrefs={() => {}} onGo={() => {}} />);
    const alert = await screen.findByRole('alert', {}, { timeout: 8000 });
    expect(alert.textContent).toContain('没加载出来。刷新一下页面再点。');
    expect(within(alert).getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '推送提醒' })).toBeTruthy();
  });
});
