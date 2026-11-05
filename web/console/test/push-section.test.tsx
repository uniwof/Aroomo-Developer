/** X-08 设置 → 推送提醒：不自动问通知权限；点了才问、才订阅；服务器没开 / 浏览器不支持 / iPhone 没装到主屏幕 / 已拒绝都说清楚；关掉会删订阅。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PushSection } from '@/chat/push-section';
import { session } from '@/lib/api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const KEY = 'BL4ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFGHIJKLMNOPQRSTU';
const SUB_JSON = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } };

type Calls = Array<{ method: string; url: string; body?: unknown }>;

function stubApi(status: { enabled: boolean; publicKey: string | null; devices: number }, calls: Calls) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/push') return json(200, status);
      if (url === '/api/push/test') return json(200, { sent: 1 });
      return json(200, { ok: true });
    }),
  );
}

/** 装一个假的浏览器推送环境；sub = 现在有没有订阅 */
function stubBrowser(opts: { permission?: NotificationPermission; sub?: boolean; ask?: NotificationPermission } = {}) {
  let sub: { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> } | null = opts.sub
    ? { endpoint: SUB_JSON.endpoint, toJSON: () => SUB_JSON, unsubscribe: vi.fn(async () => true) }
    : null;
  const pushManager = {
    getSubscription: vi.fn(async () => sub),
    subscribe: vi.fn(async (_opts: PushSubscriptionOptionsInit) => {
      sub = { endpoint: SUB_JSON.endpoint, toJSON: () => SUB_JSON, unsubscribe: vi.fn(async () => true) };
      return sub;
    }),
  };
  const reg = { pushManager };
  const requestPermission = vi.fn(async () => opts.ask ?? 'granted');
  vi.stubGlobal('Notification', Object.assign(function () {}, { permission: opts.permission ?? 'default', requestPermission }));
  vi.stubGlobal('PushManager', function () {});
  const sw = { getRegistration: vi.fn(async () => reg), register: vi.fn(async () => reg), ready: Promise.resolve(reg) };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  return { requestPermission, pushManager, sw, current: () => sub };
}

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
  // @ts-expect-error 测试里装的假 serviceWorker，删掉还原
  delete navigator.serviceWorker;
});

describe('设置 → 推送提醒', () => {
  it('没打开：讲清楚会收到什么；不自动问权限；点「在这台设备上打开」才问、注册 SW、把订阅交给 Core', async () => {
    session.set('placeholder-session');
    const calls: Calls = [];
    stubApi({ enabled: true, publicKey: KEY, devices: 0 }, calls);
    const b = stubBrowser();
    render(<PushSection />);
    const btn = await screen.findByRole('button', { name: '在这台设备上打开' });
    expect(screen.getByText(/锁屏上会出现一句提醒/)).toBeInTheDocument();
    expect(screen.getByText(/不含具体内容/)).toBeInTheDocument();
    expect(b.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/push/subscriptions')).toBe(true));
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    expect(b.sw.register).toHaveBeenCalledWith('/console/sw.js', { scope: '/console/' });
    expect(b.pushManager.subscribe.mock.calls[0]![0]).toMatchObject({ userVisibleOnly: true });
    expect(calls.find((c) => c.url === '/api/push/subscriptions')!.body).toEqual(SUB_JSON);
    expect(await screen.findByRole('status')).toHaveTextContent('已打开');
  });

  it('浏览器没允许：不订阅，说明原因', async () => {
    session.set('placeholder-session');
    const calls: Calls = [];
    stubApi({ enabled: true, publicKey: KEY, devices: 0 }, calls);
    const b = stubBrowser({ ask: 'denied' });
    render(<PushSection />);
    fireEvent.click(await screen.findByRole('button', { name: '在这台设备上打开' }));
    expect(await screen.findByText(/没允许 Aroomo 发通知/)).toBeInTheDocument();
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('已打开：可以发一条试试、在这台设备上关掉（先告诉 Core 删，再取消浏览器订阅）', async () => {
    session.set('placeholder-session');
    const calls: Calls = [];
    stubApi({ enabled: true, publicKey: KEY, devices: 2 }, calls);
    const b = stubBrowser({ permission: 'granted', sub: true });
    render(<PushSection />);
    expect(await screen.findByText('2 台设备在收')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发一条试试' }));
    expect(await screen.findByText(/已发出，1 台设备会收到/)).toBeInTheDocument();
    const sub = b.current()!;
    fireEvent.click(screen.getByRole('button', { name: '在这台设备上关掉' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/push/subscriptions/remove')).toBe(true));
    expect(calls.find((c) => c.url === '/api/push/subscriptions/remove')!.body).toEqual({ endpoint: SUB_JSON.endpoint });
    await waitFor(() => expect(sub.unsubscribe).toHaveBeenCalled());
  });

  it('服务器没开：只说一句，没有按钮', async () => {
    session.set('placeholder-session');
    stubApi({ enabled: false, publicKey: null, devices: 0 }, []);
    stubBrowser();
    render(<PushSection />);
    expect(await screen.findByText('服务器还没有打开推送提醒')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('iPhone 没装到主屏幕（没有推送接口）：告诉她先「添加到主屏幕」', async () => {
    session.set('placeholder-session');
    stubApi({ enabled: true, publicKey: KEY, devices: 0 }, []);
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 });
    render(<PushSection />);
    expect(await screen.findByText(/添加到主屏幕/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('之前拒绝过通知：说明去浏览器设置里改', async () => {
    session.set('placeholder-session');
    stubApi({ enabled: true, publicKey: KEY, devices: 0 }, []);
    stubBrowser({ permission: 'denied' });
    render(<PushSection />);
    expect(await screen.findByText(/网站设置里把「通知」改成允许/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
