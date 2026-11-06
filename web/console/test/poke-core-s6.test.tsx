/** Poke Core 数据 切片 6：/console 驾驶舱（§3）只用现有接口；指标跳去对应页面；动态能打开的才是按钮 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { viewOf } from '@/chat/routes';

const M = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, ...extra });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let failInbox = false;
let role = 'owner';
beforeEach(() => {
  localStorage.clear();
  failInbox = false;
  role = 'owner';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [M('m1', '甲模型', { activity: { state: 'working' } }), M('m2', '乙模型', { activity: { state: 'ready' } }), M('m3', '丙模型', { status: 'candidate' })] });
      if (url.startsWith('/api/inbox/unread-count')) return failInbox ? json({}, 500) : json({ total: 2 });
      if (url === '/api/capabilities') return json({ items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
      if (url.startsWith('/api/audit'))
        return json({
          entries: [
            { id: 'e1', ts: '2026-11-06T02:00:00Z', actor: { type: 'owner', id: 'owner' }, action: 'members.update', target: { type: 'member', id: 'm1' }, result: 'ok' },
            { id: 'e2', ts: '2026-11-06T01:00:00Z', actor: { type: 'system', id: 'jobs' }, action: 'keys.reconcile.missing', target: { type: 'key', id: 'k1' }, result: 'failed' },
          ],
          nextCursor: null,
        });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const at = (path: string) => {
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role }));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
      <Where />
    </MemoryRouter>,
  );
};
const main = () => screen.getByRole('main');

describe('切片 6：驾驶舱', () => {
  it('/console 直接打开；/work 没有数据来源，仍落到对话（不做假页面）', () => {
    expect(viewOf('/console', '')).toEqual({ kind: 'console' });
    expect(viewOf('/work', '')).toEqual({ kind: 'chat' });
  });

  it('指标都来自 Core：在职 2、工作中 1、等你处理 2、资源库 3；点了去对应页面', async () => {
    at('/console');
    expect(await within(main()).findByRole('button', { name: /在职成员\s*2/ })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: /工作中\s*1/ })).toBeInTheDocument();
    expect(await within(main()).findByRole('button', { name: /等你处理\s*2/ })).toBeInTheDocument();
    expect(await within(main()).findByRole('button', { name: /资源库能力\s*3/ })).toBeInTheDocument();
    fireEvent.click(within(main()).getByRole('button', { name: /等你处理/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/inbox'));
  });

  it('最近动态：成员那条是按钮，打开那位成员；Key 那条只是一行字', async () => {
    at('/console');
    const open = await within(main()).findByRole('button', { name: /^打开：所有者 · members\.update/ });
    expect(within(main()).queryByRole('button', { name: /keys\.reconcile\.missing/ })).toBeNull();
    expect(within(main()).getByText('系统 · keys.reconcile.missing')).toBeInTheDocument();
    fireEvent.click(open);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/team?member=m1'));
  });

  it('读不到不编数字：写「没读到」并给重试；刷新键能点', async () => {
    failInbox = true;
    at('/console');
    expect(await within(main()).findByRole('button', { name: /等你处理\s*没读到/ })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: /重试/ })).toBeInTheDocument();
    failInbox = false;
    fireEvent.click(within(main()).getByRole('button', { name: '刷新驾驶舱' }));
    expect(await within(main()).findByRole('button', { name: /等你处理\s*2/ })).toBeInTheDocument();
  });

  it('家人账号：没有资源库和审计，只看自己的成员和收件箱', async () => {
    role = 'user';
    at('/console');
    expect(await within(main()).findByRole('button', { name: /等你处理\s*2/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: /资源库能力/ })).toBeNull();
    expect(within(main()).queryByText('最近动态')).toBeNull();
  });
});
