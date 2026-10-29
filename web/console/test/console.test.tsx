import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MemberAvatar, QuotaRing, quotaFraction } from '@/components/brand';
import { api, login, session, ApiError } from '@/lib/api';
import { App } from '@/App';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('品牌（D7）', () => {
  it('额度圆环：按比例，超界截断，未知不编造', () => {
    expect(quotaFraction(30, 100)).toBe(0.3);
    expect(quotaFraction(150, 100)).toBe(1);
    expect(quotaFraction(null, 100)).toBeNull();
    expect(quotaFraction(1, 0)).toBeNull();
    render(<QuotaRing />);
    expect(screen.getByRole('img', { name: '额度：暂无数据' })).toBeInTheDocument();
    expect(screen.queryByTestId('quota-arc')).toBeNull();
    cleanup();
    render(<QuotaRing used={45} limit={100} />);
    expect(screen.getByRole('img', { name: '额度已用 45%' })).toBeInTheDocument();
  });

  it('头像：在线彩色、离线黑白', () => {
    const { container } = render(
      <>
        <MemberAvatar name="gpt-oss" online />
        <MemberAvatar name="Kimi" online={false} />
      </>,
    );
    const [on, off] = container.querySelectorAll('[data-online]');
    expect(on!.className).not.toContain('grayscale');
    expect(off!.className).toContain('grayscale');
    expect(off!.getAttribute('title')).toBe('Kimi（离线）');
  });
});

describe('调用 Core', () => {
  it('登录后令牌存 sessionStorage，之后带 Bearer；改动类请求带 X-Aroomo-Request', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === '/auth/login') return json(200, { token: 'placeholder-session', user: { id: 'u1', email: 'a@b.c', role: 'owner' } });
      return json(200, { members: [] });
    }) as unknown as typeof fetch;
    const u = await login('a@b.c', 'pw', f);
    expect(u.id).toBe('u1');
    expect(session.token).toBe('placeholder-session');
    expect((calls[0]!.init.headers as Record<string, string>)['x-aroomo-request']).toBe('1');
    await api('GET', '/api/members', undefined, f);
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer placeholder-session');
    expect(h['x-aroomo-request']).toBeUndefined();
  });

  it('401 时清掉令牌并抛出 ApiError', async () => {
    session.set('placeholder-old');
    const f = (async () => json(401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } })) as unknown as typeof fetch;
    await expect(api('GET', '/api/members', undefined, f)).rejects.toBeInstanceOf(ApiError);
    expect(session.token).toBeNull();
  });
});

describe('页面', () => {
  it('未登录显示登录页；登录成功进入成员页并列出成员', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/auth/login') return json(200, { token: 'placeholder-session', user: { id: 'u1', email: 'a@b.c', role: 'owner' } });
        if (url === '/api/members')
          return json(200, {
            members: [
              { id: 'm1', name: 'gpt-oss-20b', aliases: [], capabilityTags: ['对话'], enabled: true, pinned: false, status: 'active', leadEligible: true },
              { id: 'm2', name: 'Kimi', aliases: [], capabilityTags: [], enabled: false, pinned: false, status: 'active', leadEligible: false },
            ],
          });
        return json(404, { error: { code: 'NOT_FOUND', message: '找不到' } });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '登录 Aroomo 控制台' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '能力地图与成员' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('gpt-oss-20b')).toBeInTheDocument());
    expect(screen.getByTitle('Kimi（离线）')).toHaveAttribute('data-online', 'false');
    expect(screen.getByRole('navigation', { name: '控制台' }).querySelectorAll('a')).toHaveLength(7);
  });

  it('登录失败给出提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'BAD_CREDENTIALS', message: 'x' } })));
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱或密码不对');
  });
});
