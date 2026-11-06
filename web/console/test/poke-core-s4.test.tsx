/** Poke Core 数据 切片 4：决定卡的 发起 / 风险 / 证据 / 影响范围，拒绝写理由（§8） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Inbox } from '@/pages/Inbox';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const ITEM = {
  id: 'i1',
  group: 'decision',
  title: '示例助手想调用付费模型',
  summary: '成员：示例付费模型',
  urgency: 'normal',
  actor: { type: 'assistant', id: 'a1', name: '示例助手' },
  impact: ['付费模型：示例付费模型', '这次运行的付费额度'],
  actions: [
    { id: 'approve', label: '同意', confirm: { kind: 'payment', consequences: ['会用掉付费额度。'] } },
    { id: 'reject', label: '拒绝' },
  ],
  createdAt: '2026-11-06T02:00:00Z',
};
let posts: Array<{ url: string; body: string }> = [];
let items: Record<string, unknown>[] = [];
beforeEach(() => {
  posts = [];
  items = [ITEM];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: String(init.body ?? '') });
        const reason = (JSON.parse(String(init.body || '{}')) as { reason?: string }).reason;
        items = [];
        return json({ item: { ...ITEM, status: 'done', resolvedAction: 'reject', ...(reason ? { resolvedNote: reason } : {}) } });
      }
      if (url.startsWith('/api/inbox/unread-count')) return json({ total: items.length });
      if (url.startsWith('/api/inbox')) return json({ groups: { decision: items, candidate: [], brief: [] } });
      if (url === '/api/tasks') return json({ tasks: [] });
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('切片 4：决定卡', () => {
  it('按 动作 / 发起 / 风险 / 证据 / 影响范围 写出来（不藏在悬停里）', async () => {
    render(<Inbox />);
    const card = (await screen.findByText('示例助手想调用付费模型')).closest('li')!;
    expect(card).toHaveTextContent('发起：示例助手');
    expect(card).toHaveTextContent('风险：高（会花钱）：会用掉付费额度。');
    expect(card).toHaveTextContent('成员：示例付费模型');
    expect(card).toHaveTextContent('影响范围：付费模型：示例付费模型；这次运行的付费额度');
  });

  it('老条目没有发起者 / 影响范围：写「未注明」，不编', async () => {
    items = [{ ...ITEM, actor: undefined, impact: undefined, actions: [{ id: 'ack', label: '知道了' }] }];
    render(<Inbox />);
    const card = (await screen.findByText('示例助手想调用付费模型')).closest('li')!;
    expect(card).toHaveTextContent('发起：未注明');
    expect(card).toHaveTextContent('风险：普通');
    expect(card).toHaveTextContent('影响范围：未注明');
  });

  it('拒绝：先弹确认可写理由；取消什么都不发；确定后带上理由，结果里说出 Core 存下的理由', async () => {
    render(<Inbox />);
    const card = (await screen.findByText('示例助手想调用付费模型')).closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: '拒绝' }));
    let dlg = await screen.findByRole('dialog', { name: '拒绝「示例助手想调用付费模型」？' });
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    expect(posts).toEqual([]);
    fireEvent.click(within(card).getByRole('button', { name: '拒绝' }));
    dlg = await screen.findByRole('dialog', { name: '拒绝「示例助手想调用付费模型」？' });
    fireEvent.change(within(dlg).getByLabelText('理由（可不填）'), { target: { value: '这周不想花钱' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/inbox/i1/actions/reject', body: '{"reason":"这周不想花钱"}' }]));
    expect(await screen.findByText(/已处理：拒绝「示例助手想调用付费模型」（理由：这周不想花钱）/)).toBeInTheDocument();
  });

  it('不写理由也能拒绝（理由可选）', async () => {
    render(<Inbox />);
    const card = (await screen.findByText('示例助手想调用付费模型')).closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: '拒绝' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/inbox/i1/actions/reject', body: '{}' }]));
  });
});
