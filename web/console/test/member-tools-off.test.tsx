/**
 * 成员工具分配 v1 切片 1 前端 · 开关关着（docs/api/design-member-tools-v1.md；Poke 清单第 9 项后半）：
 * 开关 MEMBER_TOOLS 关着（仓库默认）：成员详情没有这一组、不请求 /api/members/:id/tools；资源库没有「算力」一行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

// 不 mock：用仓库里真的开关值（默认 false）

const M = (id: string, name: string) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false });
type Call = { method: string; url: string };
let calls: Call[] = [];
let assigned: { tool: string; description: string | null; risk: string | null; available: boolean; assignedAt: string }[] = [];
let listStatus = 200;
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
    </MemoryRouter>,
  );
const main = () => screen.getByRole('main');
const hitTools = () => calls.some((c) => c.url.startsWith('/api/members/m1/tools'));

describe('开关关着（默认）', () => {
  it('成员详情没有「已分配的工具」，也不请求分配接口；资源库没有算力一行', async () => {
    at('/team?member=m1');
    expect(await within(main()).findByRole('button', { name: '停用 Kimi' })).toBeInTheDocument();
    expect(within(main()).queryByText('已分配的工具')).toBeNull();
    expect(hitTools()).toBe(false);
    cleanup();
    at('/hub');
    expect(await screen.findByText('外部接入（MCP）')).toBeInTheDocument();
    expect(screen.queryByText('算力（电脑助手）')).toBeNull();
  });
});

