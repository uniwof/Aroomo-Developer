import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

import { Library } from '../src/pages/Library';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('资源库页', () => {
  it('列出条目，删除要点两次', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${url}`);
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ items: [{ id: 'a', kind: 'link', title: '好文', url: 'https://x.test', body: '', tags: ['ai'], source: 'manual', createdAt: '' }] }), { status: 200 });
      }),
    );
    render(<Library />);
    await screen.findByText('好文');
    fireEvent.click(screen.getByRole('button', { name: '删除 好文' }));
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认删除 好文' }));
    await waitFor(() => expect(calls.some((c) => c === 'DELETE /api/library/a')).toBe(true));
  });
});
