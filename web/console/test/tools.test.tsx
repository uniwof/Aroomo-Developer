import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Tools, groupTools } from '../src/pages/Tools';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('工具页', () => {
  it('按分组显示，额度未知', async () => {
    const tools = [
      { id: 'a', name: '沙盒A', group: '沙盒', access: 'free', status: 'ready', quota: null, note: null },
      { id: 'b', name: '算力B', group: '算力', access: 'trial', status: 'missing', quota: { used: 1, limit: 10, unit: '小时' }, note: null },
    ];
    expect(groupTools(tools as never).map(([g]) => g)).toEqual(['沙盒', '算力']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tools }), { status: 200 })));
    render(<Tools />);
    await screen.findByText('沙盒A');
    expect(screen.getByText(/额度：未知/)).toBeTruthy();
    expect(screen.getByText(/已用 1 \/ 10 小时/)).toBeTruthy();
  });
});
