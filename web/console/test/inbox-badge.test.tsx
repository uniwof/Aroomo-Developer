import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('导航里的收件箱数字', () => {
  it('有待处理时显示数字并带读屏文字；查不到时不显示', async () => {
    session.set('x');
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { total: 3, byGroup: { decision: 3 } })));
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    expect(await screen.findByText('条待处理', { exact: false })).toBeInTheDocument();
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => json(500, {})));
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('条待处理', { exact: false })).toBeNull();
  });
});
