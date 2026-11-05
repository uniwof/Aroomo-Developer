import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Audit } from '@/pages/Audit';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const page1 = [
  { id: 'e1', ts: '2026-11-02T04:05:00.000Z', actor: { type: 'client', id: 'c1' }, action: 'gateway.call', target: { type: 'tool', id: 'read_webpage' }, result: 'ok' },
  { id: 'e2', ts: '2026-11-02T04:04:00.000Z', actor: { type: 'client', id: 'c1' }, action: 'gateway.call', target: { type: 'tool', id: 'browser_task_create' }, result: 'denied', note: 'mcp: not_read' },
];
const page2 = [{ id: 'e3', ts: '2026-11-02T04:03:00.000Z', actor: { type: 'owner', id: 'owner' }, action: 'mcp.call', target: { type: 'mcp', id: 'call_tool' }, result: 'failed' }];

describe('审计页', () => {
  it('列出记录（结果用文字）、客户端显示名字、加载更多用 nextCursor、按前缀和结果筛选', async () => {
    session.set('placeholder-session');
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url === '/api/clients') return json(200, { clients: [{ id: 'c1', name: 'LobeHub' }], availableScopes: [] });
        if (url === '/api/audit?limit=50') return json(200, { entries: page1, nextCursor: 'cur1' });
        if (url === '/api/audit?limit=50&cursor=cur1') return json(200, { entries: page2, nextCursor: null });
        return json(404, {});
      }),
    );
    render(<Audit />);
    const list = await screen.findByRole('list', { name: '审计记录' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByText('成功')).toBeInTheDocument();
    expect(within(list).getByText('被拒绝')).toBeInTheDocument();
    expect(within(list).getByText('备注：mcp: not_read')).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByText(/客户端「LobeHub」/)).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(urls).toContain('/api/audit?limit=50&cursor=cur1');
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    // 按钮没了：焦点落到状态行（Groq 审查点）
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
    expect(within(list).getByText('失败')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('动作开头'), { target: { value: 'gateway.' } });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('结果'), { target: { value: 'denied' } });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 条');
    // unify5：照 sumus 用细边分组卡（一行一条），不再是灰底卡片；筛不出东西时一句空状态
    expect(list).toHaveClass('group');
    expect(document.querySelector('.card-muted')).toBeNull();
    fireEvent.change(screen.getByLabelText('动作开头'), { target: { value: 'nothing.' } });
    expect(await screen.findByText('没有符合筛选的记录。')).toBeInTheDocument();
  });

  it('账号用户（403）：只说明「审计只有所有者能看」，不报错', async () => {
    session.set('placeholder-session');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(403, { error: { code: 'FORBIDDEN', message: '没有权限执行这个操作' } })),
    );
    render(<Audit />);
    expect(await screen.findByText('审计只有所有者能看。')).toBeInTheDocument();
    expect(screen.queryByText('没有权限执行这个操作')).toBeNull();
  });
});
