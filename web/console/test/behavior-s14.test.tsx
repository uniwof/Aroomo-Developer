/** Poke 行为规范 切片 14（验收清单 3）：面板读取失败时给「重试」，点了重新读，读到就正常显示 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { ApiView, LibraryView, ToolsView } from '@/chat/views';
import { Inbox } from '@/pages/Inbox';
import { Audit } from '@/pages/Audit';
import { Executors } from '@/pages/Executors';
import { CapabilityMap } from '@/components/CapabilityMap';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
/** 每个地址第一次读失败（500），之后成功 */
let ok: Record<string, unknown> = {};
let seen: Record<string, number> = {};
beforeEach(() => {
  localStorage.clear();
  seen = {};
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const k = Object.keys(ok).find((x) => url === x || url.startsWith(x + '?'));
      if (!k) return new Response('{}', { status: 404 });
      seen[k] = (seen[k] ?? 0) + 1;
      return seen[k] === 1 ? json({ error: { message: '后台忙' } }, 500) : json(ok[k]);
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
const retry = async (what: RegExp) => fireEvent.click(await screen.findByRole('button', { name: what }, { timeout: 4000 }));

describe('切片 14：读取失败可以重试', () => {
  it('成员页：列表没读到不再说「还没有成员」，给重试', async () => {
    ok = { '/api/members': { members: [{ id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false }] } };
    render(
      <MemoryRouter initialEntries={['/team']}>
        <ChatPage />
      </MemoryRouter>,
    );
    const main = screen.getByRole('main');
    await within(main).findByRole('button', { name: /重新加载成员/ }, { timeout: 8000 });
    expect(within(main).queryByText('还没有成员。')).toBeNull();
    fireEvent.click(within(main).getByRole('button', { name: /重新加载成员/ }));
    expect(await within(main).findByRole('button', { name: /Kimi/ })).toBeInTheDocument();
  }, 20000);

  it('资源库：模型清单读失败可重试', async () => {
    ok = { '/api/capabilities': { items: [{ id: 'c1', name: 'Qwen', kind: 'text', provider: '示例', access: 'free' }] }, '/api/library': { items: [] } };
    render(<LibraryView onAddMember={() => undefined} />);
    await retry(/重新加载可以添加的成员/);
    expect(await screen.findByRole('button', { name: /^添加 Qwen/ })).toBeInTheDocument();
    await retry(/重新加载收藏/);
    expect(await screen.findByText('还没有收藏。')).toBeInTheDocument();
  });

  it('工具：读失败可重试', async () => {
    ok = { '/api/capabilities': { tools: [{ id: 't1', name: '搜索', group: '查资料', access: 'free', status: 'ready', quota: null, note: null }] }, '/api/gateway/tools': { tools: [] } };
    render(<ToolsView onGo={() => undefined} />);
    await retry(/重新加载工具/);
    expect(await screen.findByText('搜索')).toBeInTheDocument();
  });

  it('API：Key 读失败可重试', async () => {
    ok = { '/api/keys': { keys: [{ id: 'k1', name: '我的 Key', sourceUrl: 'https://x.example', last4: '1234', status: 'active', updatedAt: 'x' }] } };
    render(<ApiView members={[]} />);
    await retry(/重新加载 Key/);
    expect(await screen.findByText('我的 Key')).toBeInTheDocument();
  });

  it('收件箱：读失败可重试', async () => {
    ok = { '/api/inbox': { groups: {} }, '/api/executor-takeovers': { cards: [] } };
    render(<Inbox />);
    await retry(/重新加载收件箱/);
    expect(await screen.findByText(/收件箱是空的/)).toBeInTheDocument();
  });

  it('审计：读失败可重试', async () => {
    ok = { '/api/audit': { entries: [{ id: 'a1', ts: '2026-11-05T00:00:00Z', actor: { type: 'owner', id: 'o' }, action: 'gateway.call', target: { type: 't', id: '1' }, result: 'ok' }], nextCursor: null }, '/api/clients': { clients: [] } };
    render(<Audit />);
    await retry(/重新加载审计记录/);
    expect(await screen.findByText('gateway.call')).toBeInTheDocument();
  });

  it('电脑助手：读失败可重试', async () => {
    ok = { '/api/executors': { executors: [{ id: 'e1', deviceName: '书房电脑', platform: 'win32', version: '1', adapters: [], lastSeenAt: new Date().toISOString(), online: true }] }, '/api/tasks': { tasks: [] } };
    render(<Executors />);
    await retry(/重新加载电脑助手/);
    expect(await screen.findByText('书房电脑')).toBeInTheDocument();
  });

  it('能力地图：读失败可重试', async () => {
    ok = { '/api/capabilities': { items: [] } };
    render(<CapabilityMap />);
    await retry(/重新加载能力地图/);
    expect(await screen.findByTestId('cap-summary')).toBeInTheDocument();
  });
});
