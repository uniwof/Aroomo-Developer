/** Poke 行为规范 切片 8：成员详情里的 启用 / 停用 / 入职（接现有 Core 接口；停用先确认） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const M = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, ...extra });
let members: Record<string, unknown>[] = [];
let calls: string[] = [];
let fail = false;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const asOwner = (role = 'owner') => sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role }));
beforeEach(() => {
  localStorage.clear();
  calls = [];
  fail = false;
  asOwner();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push(`${method} ${url} ${init?.body ?? ''}`);
      if (url === '/api/members' && method === 'GET') return json({ members });
      const m = /^\/api\/members\/([^/]+)(\/onboard)?$/.exec(url);
      if (m && method !== 'GET') {
        if (fail) return json({ error: { code: 'X', message: '后台没答应' } }, 500);
        const id = m[1]!;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        members = members.map((x) => (x.id === id ? { ...x, ...(m[2] ? { status: 'active' } : body) } : x));
        return json({ member: members.find((x) => x.id === id) });
      }
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
    </MemoryRouter>,
  );
const main = () => screen.getByRole('main');

describe('切片 8：成员详情的启用 / 停用 / 入职', () => {
  it('停用先确认；取消什么都不发；确定后 PATCH enabled:false，详情立刻变成「已停用」并给「启用」', async () => {
    members = [M('m1', 'Kimi')];
    at('/team?member=m1');
    fireEvent.click(await within(main()).findByRole('button', { name: '停用 Kimi' }));
    const dlg = await screen.findByRole('dialog', { name: '停用 Kimi？' });
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    expect(calls).toEqual([]);
    fireEvent.click(within(main()).getByRole('button', { name: '停用 Kimi' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '停用 Kimi？' })).getByRole('button', { name: '停用' }));
    await waitFor(() => expect(calls).toEqual(['PATCH /api/members/m1 {"enabled":false}']));
    expect(await within(main()).findByRole('button', { name: '启用 Kimi' })).toBeInTheDocument();
    expect(within(main()).getByText('已停用', { selector: '.muted' })).toBeInTheDocument();
    expect(within(main()).getAllByRole('status').some((el) => el.textContent === '已停用 Kimi')).toBe(true);
  });

  it('启用不用确认，直接 PATCH enabled:true', async () => {
    members = [M('m1', 'Kimi', { enabled: false })];
    at('/team?member=m1');
    fireEvent.click(await within(main()).findByRole('button', { name: '启用 Kimi' }));
    await waitFor(() => expect(calls).toEqual(['PATCH /api/members/m1 {"enabled":true}']));
    expect(await within(main()).findByRole('button', { name: '停用 Kimi' })).toBeInTheDocument();
  });

  it('候选成员：「入职」走 POST /onboard，成功后变成在职', async () => {
    members = [M('m2', '候选甲', { status: 'candidate' })];
    at('/team?member=m2');
    fireEvent.click(await within(main()).findByRole('button', { name: '让 候选甲 入职' }));
    await waitFor(() => expect(calls[0]).toMatch(/^POST \/api\/members\/m2\/onboard/));
    await waitFor(() => expect(within(main()).queryByRole('button', { name: '让 候选甲 入职' })).toBeNull());
  });

  it('家人账号看不到「入职」（Core 只给所有者）', async () => {
    asOwner('user');
    members = [M('m2', '候选甲', { status: 'candidate' })];
    at('/team?member=m2');
    await within(main()).findByRole('button', { name: '停用 候选甲' });
    expect(within(main()).queryByRole('button', { name: /入职/ })).toBeNull();
  });

  it('失败时说清楚，按钮还能再点', async () => {
    members = [M('m1', 'Kimi', { enabled: false })];
    fail = true;
    at('/team?member=m1');
    fireEvent.click(await within(main()).findByRole('button', { name: '启用 Kimi' }));
    expect(await within(main()).findByRole('alert')).toHaveTextContent('后台没答应');
    expect(within(main()).getByRole('button', { name: '启用 Kimi' })).not.toBeDisabled();
  });
});
