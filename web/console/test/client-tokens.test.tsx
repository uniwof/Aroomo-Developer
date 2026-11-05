import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ClientTokens } from '@/components/ClientTokens';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SCOPES = ['memory:read', 'tools:list', 'tools:call'];

/** 假后端：按会话区分两个账号（所有者 / 小号），和真后端一样按 scopeOf 隔离；别人的令牌表现为 404 */
function fakeCore() {
  const byUser: Record<string, Array<Record<string, unknown>>> = { 'sess-owner': [], 'sess-alt': [] };
  let n = 0;
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
    const mine = byUser[auth];
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (!mine) return json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    if (url === '/api/clients' && method === 'GET') return json(200, { clients: mine, availableScopes: SCOPES });
    if (url === '/api/clients' && method === 'POST') {
      n += 1;
      const client = { id: `00000000-0000-4000-8000-00000000000${n}`, name: body.name, scopes: body.scopes, rateLimitPerMin: 60, createdAt: '2026-11-03T00:00:00.000Z', expiresAt: body.expiresInDays ? '2026-12-03T00:00:00.000Z' : null, lastUsedAt: null, revokedAt: null };
      mine.push(client);
      return json(201, { token: `fake-test-token-${n}`, client });
    }
    const m = url.match(/^\/api\/clients\/(.+)$/);
    if (m && method === 'DELETE') {
      const c = mine.find((x) => x.id === m[1]);
      if (!c) return json(404, { error: { code: 'NOT_FOUND', message: '找不到这个客户端' } });
      c.revokedAt = '2026-11-03T01:00:00.000Z';
      return new Response(null, { status: 204 });
    }
    return json(404, {});
  });
  return { fetchImpl, calls, byUser };
}

describe('客户端令牌', () => {
  it('新建：范围默认不勾、勾选 tools:list/tools:call；令牌只显示一次，关掉后列表里也没有；吊销走确认', async () => {
    const core = fakeCore();
    vi.stubGlobal('fetch', core.fetchImpl);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    session.set('sess-owner');
    render(<ClientTokens />);

    const listBox = await screen.findByRole('checkbox', { name: /查看工具列表/ });
    const callBox = screen.getByRole('checkbox', { name: /调用工具/ });
    for (const b of screen.getAllByRole('checkbox')) expect(b).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: 'LobeHub' } });
    fireEvent.click(listBox);
    fireEvent.click(callBox);
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '新建连接密码' }));

    const card = await screen.findByRole('region', { name: '新连接密码（只显示一次）' });
    expect(core.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'LobeHub', scopes: ['tools:list', 'tools:call'], expiresInDays: 30 });
    expect(within(card).getByLabelText('连接密码')).toHaveTextContent('fake-test-token-1');
    expect(screen.getByRole('status')).toHaveTextContent('只显示这一次');
    fireEvent.click(within(card).getByRole('button', { name: '复制连接密码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('fake-test-token-1'));

    const list = screen.getByRole('list', { name: '连接密码列表' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByText('范围：tools:list、tools:call')).toBeInTheDocument();
    expect(list).not.toHaveTextContent('fake-test-token-1');

    fireEvent.click(within(card).getByRole('button', { name: '我已复制，关掉' }));
    expect(screen.queryByText('fake-test-token-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '停用 LobeHub' }));
    const dlg = screen.getByRole('alertdialog');
    expect(core.calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dlg).getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(core.calls.some((c) => c.method === 'DELETE' && c.url === '/api/clients/00000000-0000-4000-8000-000000000001')).toBe(true));
    await waitFor(() => expect(within(list).queryAllByRole('listitem')).toHaveLength(0));
    expect(screen.getByRole('status')).toHaveTextContent('已停用「LobeHub」');
  });

  it('过期的令牌标「已过期」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(200, {
          clients: [{ id: 'x1', name: '旧的', scopes: ['tools:list'], rateLimitPerMin: 60, createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-02-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null }],
          availableScopes: SCOPES,
        }),
      ),
    );
    session.set('sess-owner');
    render(<ClientTokens />);
    expect(await screen.findByText(/旧的（已过期）/)).toBeInTheDocument();
  });

  it('没勾范围不发请求', async () => {
    const core = fakeCore();
    vi.stubGlobal('fetch', core.fetchImpl);
    session.set('sess-owner');
    render(<ClientTokens />);
    await screen.findByRole('checkbox', { name: /查看工具列表/ });
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: '新建连接密码' }));
    expect(await screen.findByText('至少勾选一个范围')).toBeInTheDocument();
    expect(core.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('两个账号：所有者和小号各自只看到自己的令牌', async () => {
    const core = fakeCore();
    vi.stubGlobal('fetch', core.fetchImpl);
    session.set('sess-owner');
    const r1 = render(<ClientTokens />);
    fireEvent.change(await screen.findByLabelText('名字'), { target: { value: '所有者的 LobeHub' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: /查看工具列表/ }));
    fireEvent.click(screen.getByRole('button', { name: '新建连接密码' }));
    await screen.findByRole('region', { name: '新连接密码（只显示一次）' });
    r1.unmount();

    session.set('sess-alt');
    render(<ClientTokens />);
    expect(await screen.findByText('还没有可用的连接密码。')).toBeInTheDocument();
    expect(screen.queryByText('所有者的 LobeHub')).toBeNull();
    expect(core.byUser['sess-owner']).toHaveLength(1);
    expect(core.byUser['sess-alt']).toHaveLength(0);
  });
});
