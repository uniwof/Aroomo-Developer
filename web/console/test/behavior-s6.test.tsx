/** Poke 行为规范 切片 6：收件箱决定的状态机（审计 I1 I2 I4 I5，规范 §8） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Inbox } from '@/pages/Inbox';
import { TakeoverCards } from '@/components/TakeoverCards';
import { useInboxCount } from '@/lib/inbox';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const ITEM = {
  id: 'i1',
  group: 'decision',
  title: '假条目：付一笔钱',
  summary: '示例说明',
  urgency: 'normal',
  actions: [
    { id: 'approve', label: '同意' },
    { id: 'reject', label: '拒绝' },
  ],
  createdAt: '2026-11-05T10:00:00Z',
};
let calls: string[] = [];
let release: (() => void) | null = null;
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(url);
        if (url.includes('/actions/')) await new Promise<void>((r) => (release = r));
        return json({ ok: true });
      }
      if (url.startsWith('/api/inbox/unread-count')) return json({ total: calls.length ? 0 : 1 });
      if (url.startsWith('/api/inbox')) return json({ groups: { decision: calls.length ? [] : [ITEM], candidate: [], brief: [] } });
      if (url === '/api/tasks') return json({ tasks: [{ id: 't1', site: 'example.test', status: 'running' }] });
      if (url === '/api/tasks/t1/takeovers') return json({ takeovers: [{ id: 'k1', taskId: 't1', reason: 'captcha', message: '示例', status: 'pending' }] });
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Count() {
  return <p>未读 {useInboxCount()}</p>;
}

describe('切片 6：收件箱', () => {
  it('处理中锁住这一条的按钮，不能重复提交；完成后播报并刷新铃铛数', async () => {
    render(
      <>
        <Count />
        <Inbox />
      </>,
    );
    await screen.findByText('未读 1');
    const ok = await screen.findByRole('button', { name: '同意' });
    fireEvent.click(ok);
    await waitFor(() => expect(ok).toBeDisabled());
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled();
    fireEvent.click(ok);
    expect(calls.filter((c) => c.includes('/actions/'))).toHaveLength(1);
    expect(screen.getAllByRole('status').some((s) => /正在处理/.test(s.textContent ?? ''))).toBe(true);
    await act(async () => release?.());
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => /已处理/.test(s.textContent ?? ''))).toBe(true));
    await screen.findByText('未读 0');
  });

  it('拒绝先确认；关掉确认不做决定', async () => {
    render(<Inbox />);
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('heading')).toHaveTextContent('拒绝「假条目：付一笔钱」？');
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toHaveLength(0);
  });

  it('接管卡「放弃」先确认，说清是哪个任务', async () => {
    render(<TakeoverCards />);
    fireEvent.click(await screen.findByRole('button', { name: '放弃' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('heading')).toHaveTextContent('example.test');
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    expect(calls).toHaveLength(0);
  });
});
