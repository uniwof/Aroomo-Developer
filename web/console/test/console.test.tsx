import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MemberAvatar, QuotaRing, quotaFraction } from '@/components/brand';
import { api, login, session, ApiError, COOKIE_SESSION } from '@/lib/api';
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
    expect(off!.getAttribute('aria-label')).toContain('Kimi，离线');
  });
});

describe('调用 Core', () => {
  it('响应里带令牌：不收下、不存，当出错处理（只认 Cookie，#264 必改 2）；改动类请求带 X-Aroomo-Request', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, { token: 'placeholder-session', user: { id: 'u1', email: 'a@b.c', role: 'owner' } });
    }) as unknown as typeof fetch;
    await expect(login('a@b.c', 'pw', f)).rejects.toMatchObject({ code: 'LOGIN_TOKEN_IN_BODY' });
    expect(session.token).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain('placeholder-session');
    expect((calls[0]!.init.headers as Record<string, string>)['x-aroomo-request']).toBe('1');
  });

  it('Cookie 登录（Core 不返回令牌）：只记占位标记，之后请求不带 Authorization，靠 Cookie', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === '/auth/login') return json(200, { user: { id: 'u1', email: 'a@b.c', role: 'owner' } });
      return json(200, { members: [] });
    }) as unknown as typeof fetch;
    await login('a@b.c', 'pw', f);
    expect(JSON.parse(String(calls[0]!.init.body)).cookie).toBe(true);
    expect(session.token).toBe(COOKIE_SESSION);
    await api('GET', '/api/members', undefined, f);
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h.authorization).toBeUndefined();
    expect(calls[1]!.init.credentials).toBe('same-origin');
  });

  it('401 时清掉令牌并抛出 ApiError', async () => {
    session.set('placeholder-old');
    const f = (async () => json(401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } })) as unknown as typeof fetch;
    await expect(api('GET', '/api/members', undefined, f)).rejects.toBeInstanceOf(ApiError);
    expect(session.token).toBeNull();
  });
});

describe('页面', () => {
  it('未登录显示登录页；登录成功进入对话页里的成员面板并列出成员', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/auth/login') return json(200, { user: { id: 'u1', email: 'a@b.c', role: 'owner' } });
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
      <MemoryRouter initialEntries={['/members']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '登录 Aroomo' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    // 旧控制台已并进对话页（自审 C1）：/members 打开对话页里的成员面板，没有第二套侧栏
    await waitFor(() => expect(screen.getByRole('heading', { name: '成员', level: 1 })).toBeInTheDocument(), { timeout: 15000 });
    await waitFor(() => expect(screen.getAllByText('gpt-oss-20b').length).toBeGreaterThan(0));
    expect(screen.queryByRole('navigation', { name: '控制台' })).toBeNull();
  }, 20000); // 机器慢时对话页单独打包的那块要加载几秒

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

describe('能力清单（M1）', () => {
  it('汇总行、徽标、额度未知', async () => {
    const { summaryLine, quotaText } = await import('@/lib/capabilities');
    const items = [
      { id: '1', name: 'a', kind: 'text', provider: 'p', access: 'free', quota: null },
      { id: '2', name: 'b', kind: 'image', provider: 'p', access: 'trial', quota: { used: 3, limit: 10, unit: '次' } },
    ] as const;
    expect(summaryLine([...items])).toBe('能聊天 1 个 · 能画图 1 个 · 能做视频 0 个');
    expect(quotaText(null)).toBe('额度：未知');
    expect(quotaText({ used: null, limit: 10, unit: '次' })).toBe('额度：未知');
    expect(quotaText(items[1].quota)).toBe('额度：已用 3 / 10 次');
  });

  it('接口未上线(404)时显示示例数据并标明', async () => {
    const { CapabilityMap } = await import('@/components/CapabilityMap');
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: { code: 'NOT_FOUND', message: 'x' } })));
    render(<CapabilityMap />);
    await waitFor(() => expect(screen.getByTestId('cap-summary')).toHaveTextContent('能聊天 5 个 · 能画图 2 个 · 能做视频 0 个'));
    expect(screen.getByRole('note')).toHaveTextContent('示例数据');
    expect(screen.getAllByText('永久免费').length).toBeGreaterThan(0);
    expect(screen.getAllByText('试用').length).toBeGreaterThan(0);
  });
});
