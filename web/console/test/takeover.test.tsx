import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TakeoverCards } from '@/components/TakeoverCards';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('接管卡', () => {
  it('显示待处理接管卡，点「我已处理，继续」调用 resolve 且 cancel=false；放弃为 true', async () => {
    session.set('x');
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return json(200, {});
        }
        if (url === '/api/tasks') return json(200, { tasks: [{ id: 't1', site: 'example.com', status: 'running' }, { id: 't2', status: 'succeeded' }] });
        if (url === '/api/tasks/t1/takeovers')
          return json(200, { takeovers: [{ id: 'k1', taskId: 't1', reason: 'captcha', message: '请完成验证码', status: 'pending' }, { id: 'k0', taskId: 't1', reason: '2fa', message: '旧的', status: 'resolved' }] });
        return json(404, {});
      }),
    );
    render(<TakeoverCards />);
    expect(await screen.findByText('遇到验证码（example.com）')).toBeInTheDocument();
    expect(screen.queryByText('旧的')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '我已处理，继续' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/tasks/t1/takeovers/k1/resolve', body: { cancel: false } });
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].body).toEqual({ cancel: true });
  });
});
