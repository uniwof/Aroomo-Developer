import { afterEach, describe, expect, it, vi } from 'vitest';
import { session, shellLogout } from '@/lib/api';

afterEach(() => {
  session.set(null);
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('从 Shell 打开时退出登录（/aroomo/logout）', () => {
  it('同源 POST 带 X-Aroomo-Request，清掉本机记录，跳到 Shell 给的地址', async () => {
    session.set('cookie-session');
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'a@example.test' }));
    const calls: [string, RequestInit][] = [];
    const f = vi.fn(async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return json(200, { ok: true, location: '/cdn-cgi/access/logout' });
    }) as unknown as typeof fetch;
    const go = vi.fn();
    await shellLogout(f, go);
    expect(calls[0]![0]).toBe('/aroomo/logout');
    expect(calls[0]![1].method).toBe('POST');
    expect((calls[0]![1].headers as Record<string, string>)['x-aroomo-request']).toBe('1');
    expect(go).toHaveBeenCalledWith('/cdn-cgi/access/logout');
    expect(session.token).toBeNull();
    expect(sessionStorage.getItem('aroomo.console.user')).toBeNull();
  });

  it('不跳去别的网站：地址不是同站相对路径就回 /aroomo/login', async () => {
    for (const location of ['https://evil.example/x', '//evil.example', 42]) {
      const go = vi.fn();
      await shellLogout((async () => json(200, { ok: true, location })) as unknown as typeof fetch, go);
      expect(go).toHaveBeenCalledWith('/aroomo/login');
    }
  });

  it('Shell 拒绝或断网：抛出给人看的话，不跳、不清登录', async () => {
    session.set('cookie-session');
    const go = vi.fn();
    await expect(shellLogout((async () => json(403, {})) as unknown as typeof fetch, go)).rejects.toThrow('退出失败');
    await expect(shellLogout((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch, go)).rejects.toThrow('检查网络');
    expect(go).not.toHaveBeenCalled();
    expect(session.token).toBe('cookie-session');
  });
});
