/**
 * 成员工具分配 v1 切片 1 前端（docs/api/design-member-tools-v1.md；Poke 清单第 9 项后半）：
 * - 开着（这个文件 mock 成 true）：四态（加载 / 空 / 错 + 重试 / 有）；不可用的工具写明原因；分配处理中锁住、成功播报并刷新；去掉先确认；
 * - 家人账号不显示这一组、不请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

// 开关在模块加载时就决定（顶层常量，构建时内联），所以开着、关着分两个文件测；关着的见 member-tools-off.test.tsx
vi.mock('@/lib/member-tools-flag', () => ({ MEMBER_TOOLS: true }));

const M = (id: string, name: string) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false });
type Call = { method: string; url: string };
let calls: Call[] = [];
let assigned: { tool: string; description: string | null; risk: string | null; available: boolean; assignedAt: string }[] = [];
let listStatus = 200;
let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname;
  return null;
}
const json = (o: unknown, status = 200) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const AT = 'Sat 2026-11-07 10:00 AM CST (UTC+08:00)';
const gw = [
  { name: 'read_webpage', description: '读网页', risk: 'read' },
  { name: 'browser_task_create', description: '派浏览器任务', risk: 'write' },
];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  calls = [];
  assigned = [];
  listStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url === '/api/members') return json({ members: [M('m1', 'Kimi')] });
      if (url === '/api/gateway/tools') return json({ tools: gw });
      if (url === '/api/members/m1/tools' && method === 'GET') return listStatus === 200 ? json({ tools: assigned }) : json({ error: { code: 'X', message: 'x' } }, listStatus);
      const put = url.match(/^\/api\/members\/m1\/tools\/(\w+)$/);
      if (put && method === 'PUT') {
        const row = { tool: put[1]!, description: '读网页', risk: 'read', available: true, assignedAt: AT };
        assigned.push(row);
        return json({ tool: row });
      }
      if (put && method === 'DELETE') {
        assigned = assigned.filter((a) => a.tool !== put[1]);
        return new Response(null, { status: 204 });
      }
      if (url === '/api/capabilities') return json({ items: [] });
      if (url === '/api/library') return json({ items: [] });
      return json({}, 404);
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
const main = () => screen.getByRole('main');
const hitTools = () => calls.some((c) => c.url.startsWith('/api/members/m1/tools'));

describe('开关开着', () => {
  it('空状态一句 + 去「工具」页；一句实话说明分配还没接到对话', async () => {
    at('/team?member=m1');
    expect(await within(main()).findByText('还没给 Kimi 分配工具。')).toBeInTheDocument();
    expect(within(main()).getByText(/成员对话里调用工具还没接上/)).toBeInTheDocument();
    fireEvent.click(within(main()).getByRole('button', { name: '去工具页' }));
    await waitFor(() => expect(where).toBe('/hub/tools'));
  });

  it('有：可用的写风险，不可用的写明原因', async () => {
    assigned = [
      { tool: 'read_webpage', description: '读网页', risk: 'read', available: true, assignedAt: AT },
      { tool: 'weather_cn', description: null, risk: null, available: false, assignedAt: AT },
    ];
    at('/team?member=m1');
    const g = await within(main()).findByRole('region', { name: '已分配的工具' });
    expect(await within(g).findByText('读网页')).toBeInTheDocument();
    expect(within(g).getByText('可用 · 只读')).toBeInTheDocument();
    expect(within(g).getByText('weather_cn')).toBeInTheDocument();
    expect(within(g).getByText('不可用：工具在资源库里已停用或删除')).toBeInTheDocument();
  });

  it('错误一句 + 重试，重试后能显示', async () => {
    listStatus = 500;
    at('/team?member=m1');
    const retry = await within(main()).findByRole('button', { name: '重试，重新加载已分配的工具' });
    listStatus = 200;
    fireEvent.click(retry);
    expect(await within(main()).findByText('还没给 Kimi 分配工具。')).toBeInTheDocument();
  });

  it('分配：下拉只列还没分的工具；PUT 后播报并刷新列表', async () => {
    assigned = [{ tool: 'browser_task_create', description: '派浏览器任务', risk: 'write', available: true, assignedAt: AT }];
    at('/team?member=m1');
    const sel = (await within(main()).findByLabelText('选一个工具分配给 Kimi')) as HTMLSelectElement;
    await waitFor(() => expect([...sel.options].map((o) => o.value)).toEqual(['read_webpage']));
    fireEvent.change(sel, { target: { value: 'read_webpage' } });
    fireEvent.click(within(main()).getByRole('button', { name: '分配' }));
    await waitFor(() => expect(within(main()).getAllByRole('status').some((el) => el.textContent === '已把「读网页」分配给 Kimi')).toBe(true));
    expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/members/m1/tools/read_webpage')).toBe(true);
    expect(await within(main()).findByText('可用 · 只读')).toBeInTheDocument();
  });

  it('去掉：先确认（写明成员和工具），取消不发请求，确认后 DELETE 并刷新', async () => {
    assigned = [{ tool: 'read_webpage', description: '读网页', risk: 'read', available: true, assignedAt: AT }];
    at('/team?member=m1');
    fireEvent.click(await within(main()).findByRole('button', { name: '不再给 Kimi 用「读网页」' }));
    let dlg = await screen.findByRole('dialog', { name: '不再给 Kimi 用「读网页」？' });
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(main()).getByRole('button', { name: '不再给 Kimi 用「读网页」' }));
    dlg = await screen.findByRole('dialog', { name: '不再给 Kimi 用「读网页」？' });
    fireEvent.click(within(dlg).getByRole('button', { name: '去掉' }));
    expect(await within(main()).findByText('还没给 Kimi 分配工具。')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/members/m1/tools/read_webpage')).toBe(true);
  });

  it('家人账号：不显示这一组，不请求', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '家人', role: 'user' }));
    at('/team?member=m1');
    expect(await within(main()).findByRole('button', { name: '停用 Kimi' })).toBeInTheDocument();
    expect(within(main()).queryByText('已分配的工具')).toBeNull();
    expect(hitTools()).toBe(false);
  });

  it('资源库「算力（电脑助手）」进到电脑助手页', async () => {
    at('/hub');
    fireEvent.click(await screen.findByText('算力（电脑助手）'));
    await waitFor(() => expect(where).toBe('/settings/executors'));
  });
});
