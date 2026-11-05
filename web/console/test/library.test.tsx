import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';

import { LibraryView } from '../src/chat/views';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const caps = {
  items: [
    { id: 'g', name: 'gpt-oss-20b', kind: 'text', provider: 'Groq', access: 'free' },
    { id: 'a', name: 'agnes-image-2.5', kind: 'image', provider: 'Agnes AI', access: 'trial', trialEndsAt: null },
  ],
};
const saved = { items: [{ id: 'a', kind: 'link', title: '好文', url: 'https://x.test', body: '', tags: ['ai'], source: 'manual', createdAt: '' }] };

function stub(calls: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'POST') return new Response(JSON.stringify({ existed: false }), { status: 201 });
      if (url.includes('/api/capabilities')) return new Response(JSON.stringify(caps), { status: 200 });
      return new Response(JSON.stringify(saved), { status: 200 });
    }),
  );
}

describe('资源库（照 sumus Marketplace）', () => {
  it('卡片网格 + 按能做什么筛选 + 搜索；点卡片带出名字去添加成员', async () => {
    stub([]);
    const onAdd = vi.fn();
    render(<LibraryView onAddMember={onAdd} />);
    const grid = await screen.findByRole('list', { name: '可以添加的成员' });
    expect(within(grid).getAllByRole('button')).toHaveLength(2);
    expect(within(grid).getByText('免费')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '能画图' }));
    expect(within(grid).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(grid).getByRole('button', { name: /^添加 agnes-image-2.5/ }));
    expect(onAdd).toHaveBeenCalledWith('agnes-image-2.5');
    fireEvent.click(screen.getByRole('radio', { name: '全部' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索资源' }), { target: { value: 'groq' } });
    expect(within(grid).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText('好文')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }));
    expect(onAdd).toHaveBeenLastCalledWith();
  });

  it('收藏：统一弹窗收进来；删除先问一句', async () => {
    const calls: string[] = [];
    stub(calls);
    render(<LibraryView onAddMember={() => undefined} />);
    await screen.findByText('好文');
    fireEvent.click(screen.getAllByRole('button', { name: '收藏一条' })[0]!);
    const dlg = screen.getByRole('dialog', { name: '收藏一条' });
    fireEvent.change(within(dlg).getByLabelText('链接或点子（必填）'), { target: { value: 'https://y.test' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '收进来' }));
    await waitFor(() => expect(calls).toContain('POST /api/library'));
    await screen.findByText('已收进资源库');
    fireEvent.click(screen.getByRole('button', { name: '删除「好文」' }));
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除「好文」？' })).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/library/a'));
  });
});
