import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useInboxCount } from '@/lib/inbox';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('铃铛未读数 useInboxCount', () => {
  it('读到 total 就显示；每分钟刷新；接口出错当 0 不抛错', async () => {
    session.set('x');
    let total: number | null = 3;
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/inbox/unread-count');
      return total == null ? json({ error: 'nope' }, 500) : json({ total });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = renderHook(() => useInboxCount());
    expect(result.current).toBe(0);
    await waitFor(() => expect(result.current).toBe(3));

    total = 5;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(result.current).toBe(5));

    // 出错时保留上次的数，不变成报错
    total = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe(5);

    const calls = fetchMock.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock.mock.calls.length).toBe(calls); // 卸载后不再请求
  });

  it('一开始就查不到：保持 0', async () => {
    session.set('x');
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'forbidden' }, 403)));
    const { result } = renderHook(() => useInboxCount());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(0);
  });
});
