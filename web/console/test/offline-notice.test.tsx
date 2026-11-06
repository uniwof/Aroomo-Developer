/** F-020 断网提示（负责人阶段 4 裁定）：一行静态提示；断网读屏只播一次，网回来也只说一次；网络来回跳时不一闪一闪 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { OFFLINE_NOTE, ONLINE_AGAIN } from '@/chat/online';

let online = true;
const setNet = (v: boolean) => {
  online = v;
  window.dispatchEvent(new Event(v ? 'online' : 'offline'));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('断网提示（F-020）', () => {
  beforeEach(() => {
    localStorage.clear();
    online = true;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );

  /** 数状态区（role=status，读屏会播）里出现某句话的次数 */
  const countSpoken = (el: Element, text: string) => {
    const seen = { n: 0 };
    new MutationObserver(() => {
      if (el.textContent === text) seen.n += 1;
    }).observe(el, { childList: true, characterData: true, subtree: true });
    return seen;
  };

  it('断网：显示一行静态提示，读屏只播一次；网回来提示消失，也只说一次', async () => {
    const { container } = renderPage();
    expect(screen.queryByText(OFFLINE_NOTE)).toBeNull();
    const status = container.querySelector('.chat-viewport ~ p[role="status"]')!;
    const off = countSpoken(status, OFFLINE_NOTE);
    const on = countSpoken(status, ONLINE_AGAIN);

    setNet(false);
    await waitFor(() => expect(screen.getByText(OFFLINE_NOTE)).toBeInTheDocument(), { timeout: 4000 });
    // 静态的一行：本身不是播报区（播报只走状态区一次），没有动画类
    const note = screen.getByText(OFFLINE_NOTE);
    expect(note.closest('[role="status"],[role="alert"],[aria-live]')).toBeNull();
    // 再来一次 offline 事件（浏览器会重复发）：不再播
    setNet(false);
    await sleep(2000);
    expect(off.n).toBe(1);

    setNet(true);
    await waitFor(() => expect(screen.queryByText(OFFLINE_NOTE)).toBeNull(), { timeout: 4000 });
    await waitFor(() => expect(on.n).toBe(1), { timeout: 2000 });
    setNet(true);
    await sleep(2000);
    expect(on.n).toBe(1);
    expect(off.n).toBe(1);
  }, 15000);

  it('网络来回跳（一秒内断了又回来）：不显示提示，也不播报', async () => {
    const { container } = renderPage();
    const status = container.querySelector('.chat-viewport ~ p[role="status"]')!;
    const off = countSpoken(status, OFFLINE_NOTE);
    const on = countSpoken(status, ONLINE_AGAIN);
    setNet(false);
    await sleep(300);
    setNet(true);
    await sleep(300);
    setNet(false);
    await sleep(300);
    setNet(true);
    await sleep(2500);
    expect(screen.queryByText(OFFLINE_NOTE)).toBeNull();
    expect(off.n).toBe(0);
    expect(on.n).toBe(0);
  }, 10000);

  it('打开页面时就是断网：直接显示提示（不等事件）', () => {
    online = false;
    renderPage();
    expect(screen.getByText(OFFLINE_NOTE)).toBeInTheDocument();
  });
});
