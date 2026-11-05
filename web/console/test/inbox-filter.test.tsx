import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Inbox } from '@/pages/Inbox';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stub = (groups: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url.startsWith('/api/inbox?') ? json(200, { groups }) : json(404, {}))),
  );

describe('收件箱「等你处理 / 全部」（X-04）', () => {
  it('默认只列要你点一下的条目；切到「全部」才看到简报', async () => {
    session.set('x');
    stub({
      decision: [{ id: 'd1', group: 'decision', title: '小B 想调用付费模型', createdAt: 'x', actions: [{ id: 'ok', label: '同意' }] }],
      candidate: [{ id: 'c1', group: 'candidate', title: '新模型 Kimi 可以入职', createdAt: 'x', actions: [{ id: 'hire', label: '入职' }] }],
      brief: [{ id: 'b1', group: 'brief', title: '资源周报做完了', createdAt: 'x' }],
    });
    render(<Inbox />);
    const filter = await screen.findByRole('radiogroup', { name: '收件箱筛选' });
    expect(within(filter).getByRole('radio', { name: '等你处理' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText('小B 想调用付费模型')).toBeInTheDocument();
    expect(screen.getByText('新模型 Kimi 可以入职')).toBeInTheDocument();
    expect(screen.queryByText('资源周报做完了')).toBeNull();
    expect(screen.queryByRole('heading', { name: '简报' })).toBeNull();
    fireEvent.click(within(filter).getByRole('radio', { name: '全部' }));
    expect(screen.getByText('资源周报做完了')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '简报' })).toBeInTheDocument();
  });

  it('没有等你处理的事但有简报：一句话 + 「看全部」', async () => {
    session.set('x');
    stub({ decision: [], candidate: [], brief: [{ id: 'b1', group: 'brief', title: '资源周报做完了', createdAt: 'x' }] });
    render(<Inbox />);
    expect(await screen.findByText('没有等你处理的事。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '看全部（1 条）' }));
    expect(screen.getByText('资源周报做完了')).toBeInTheDocument();
  });

  it('全空：原来的空状态（回到对话）', async () => {
    session.set('x');
    stub({ decision: [], candidate: [], brief: [] });
    const back = vi.fn();
    render(<Inbox onBack={back} />);
    fireEvent.click(await screen.findByRole('button', { name: '回到对话' }));
    expect(back).toHaveBeenCalled();
  });
});
