/** Poke 行为规范 切片 13：审计里的小项 C13 C14 C15 C16 H3 H4 M6 S2 S3 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { HeaderCard } from '@/chat/HeaderCard';
import { ApiView, ToolsView } from '@/chat/views';
import { Audit } from '@/pages/Audit';
import { Executors } from '@/pages/Executors';

const M = (id: string, name: string) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false });
const usageRow = (memberId: string, name: string, state = 'ok') => ({ memberId, name, today: { requests: 3, errors: 0, limited: 0 }, last7DaysRequests: 3, quota: { used: 3, limit: 10, unit: '次' }, quotaKnown: true, ratio: 0.3, state });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let routes: Record<string, unknown> = {};
let calls: string[] = [];
let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}
beforeEach(() => {
  localStorage.clear();
  calls = [];
  routes = {};
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push(`${method} ${url}`);
      const hit = Object.keys(routes).find((k) => url === k || url.startsWith(k + '?'));
      if (hit && method === 'GET') return json(routes[hit]);
      if (method !== 'GET') return new Response(null, { status: 204 });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
});
const page = (path = '/chat') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
      <Probe />
    </MemoryRouter>,
  );

describe('切片 13：小项', () => {
  it('C13 手机：额度提示「换个成员」去挑选成员，返回回到这段对话（不是会话列表）', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    routes = { '/api/members': { members: [M('m1', 'Kimi')] }, '/api/usage': { members: [usageRow('m1', 'Kimi', 'limited')] } };
    localStorage.setItem('aroomo.chat.v1', JSON.stringify([{ id: 'c1', title: '和 Kimi', model: 'aroomo/m1', messages: [{ role: 'user', text: '在吗' }], updatedAt: 1 }]));
    page();
    fireEvent.click(await screen.findByRole('button', { name: /换个成员/ }, { timeout: 8000 }));
    await waitFor(() => expect(where).not.toBe('/chat'));
    fireEvent.click(await screen.findByRole('button', { name: '返回对话' }));
    await waitFor(() => expect(where).toBe('/chat'));
    expect(screen.queryByRole('main', { name: '对话列表' })).toBeNull();
    expect(screen.getByLabelText('输入消息')).toBeInTheDocument();
  }, 20000);

  it('C14 新对话的草稿按对象分开：全员的草稿不跑到和某位成员的新对话里', async () => {
    routes = { '/api/members': { members: [M('m1', 'Kimi')] } };
    page();
    const input = await screen.findByLabelText('输入消息');
    fireEvent.change(input, { target: { value: '给全员的草稿' } });
    fireEvent.click(screen.getAllByRole('button', { name: '新建对话' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: '和 Kimi 开新对话' }));
    await waitFor(() => expect(document.title).toMatch(/Kimi/));
    expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('');
    // 回到全员的新对话，草稿还在
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('给全员的草稿'));
  }, 20000);

  it('C15 群聊顶栏卡：打开的是全部成员，按钮就叫「查看所有成员」', () => {
    const onView = vi.fn();
    render(<HeaderCard title="甲、乙" name="甲、乙" kind="group" type="群聊 · 2 位成员" intro="" model="甲、乙" onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: '对话信息' }));
    fireEvent.click(screen.getByRole('button', { name: /查看所有成员/ }));
    expect(onView).toHaveBeenCalled();
  });

  it('C16 Shift+Esc 回输入框时也关上设置弹窗', async () => {
    page('/settings');
    await screen.findByRole('dialog', { name: '设置' });
    fireEvent.keyDown(window, { key: 'Escape', shiftKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull());
    expect(where).toBe('/chat');
  });

  it('H3 M6 API 面板：模型行和用量行都能点进对应成员（用量上限在成员详情改）', async () => {
    routes = { '/api/keys': { keys: [] }, '/api/usage': { members: [usageRow('m1', 'Kimi')] } };
    const onOpen = vi.fn();
    render(<ApiView members={[M('m1', 'Kimi') as never]} onOpenMember={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /^打开成员 Kimi/ }));
    expect(onOpen).toHaveBeenLastCalledWith('m1');
    fireEvent.click(await screen.findByRole('button', { name: /Kimi 今天的用量/ }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('H4 工具行「还没填 Key」自带「去 API」', async () => {
    routes = { '/api/capabilities': { tools: [{ id: 't1', name: '搜索', group: '查资料', access: 'free', status: 'missing', quota: null, note: null }, { id: 't2', name: '翻译', group: '查资料', access: 'free', status: 'ready', quota: null, note: null }] }, '/api/gateway/tools': { tools: [] } };
    const onGo = vi.fn();
    render(<ToolsView onGo={onGo} />);
    fireEvent.click(await screen.findByRole('button', { name: '搜索：去 API 填 Key' }));
    expect(onGo).toHaveBeenCalledWith('keys');
    expect(screen.queryByRole('button', { name: '翻译：去 API 填 Key' })).toBeNull();
  });

  it('S2 审计搜索只在已加载的里找：还有更早的记录时状态行说清楚', async () => {
    routes = { '/api/audit': { entries: [{ id: 'a1', ts: '2026-11-05T00:00:00Z', actor: { type: 'owner', id: 'o' }, action: 'gateway.call', target: { type: 't', id: '1' }, result: 'ok' }], nextCursor: 'n1' }, '/api/clients': { clients: [] } };
    render(<Audit />);
    await screen.findByText('gateway.call');
    expect(screen.getByRole('status')).not.toHaveTextContent('加载更多');
    fireEvent.change(screen.getByRole('searchbox', { name: '动作开头' }), { target: { value: 'members.' } });
    expect(screen.getByRole('status')).toHaveTextContent('只在已加载的 1 条里找');
    expect(screen.getByRole('status')).toHaveTextContent('加载更多');
  });

  it('S3 电脑助手取消任务用全站同一种确认弹窗；取消不发请求，确定才发', async () => {
    routes = {
      '/api/executors': { executors: [] },
      '/api/tasks': { tasks: [{ id: 't1', kind: 'checkin', site: 'https://a.example', status: 'running', lastStage: null, lastMessage: null, resultSummary: null, resultError: null, createdAt: new Date().toISOString() }] },
      '/api/allowlist': { domains: [] },
    };
    render(<Executors />);
    fireEvent.click(await screen.findByRole('button', { name: '取消任务 https://a.example' }));
    let dlg = await screen.findByRole('dialog', { name: '取消这个任务？' });
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '取消任务 https://a.example' }));
    dlg = await screen.findByRole('dialog', { name: '取消这个任务？' });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认取消任务' }));
    await waitFor(() => expect(calls).toEqual(['POST /api/tasks/t1/cancel']));
  });
});
