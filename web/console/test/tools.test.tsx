import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToolsView, groupTools } from '../src/chat/views';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('工具页（照 sumus Connectors）', () => {
  it('按分组列出 Core 的工具，额度未知写未知；能按「能用 / 还不能用」筛选；成员直接能用的工具单列', async () => {
    const tools = [
      { id: 'a', name: '沙盒A', group: '沙盒', access: 'free', status: 'ready', quota: null, note: null },
      { id: 'b', name: '算力B', group: '算力', access: 'trial', status: 'missing', quota: { used: 1, limit: 10, unit: '小时' }, note: null },
    ];
    expect(groupTools(tools as never).map(([g]) => g)).toEqual(['沙盒', '算力']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('gateway')
          ? new Response(JSON.stringify({ tools: [{ name: 'read_webpage', description: '读一个网页', risk: 'read', inputSchema: {} }] }), { status: 200 })
          : new Response(JSON.stringify({ tools }), { status: 200 }),
      ),
    );
    render(<ToolsView onGo={() => undefined} />);
    await screen.findByText('沙盒A');
    expect(screen.getByText(/额度：未知/)).toBeTruthy();
    expect(screen.getByText(/已用 1 \/ 10 小时/)).toBeTruthy();
    expect(await screen.findByText('读网页')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '还不能用' }));
    expect(screen.queryByText('沙盒A')).toBeNull();
    expect(screen.getByText('算力B')).toBeInTheDocument();
    expect(screen.queryByText('读网页')).toBeNull();
  });
});
