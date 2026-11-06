/** F-020 断网提示（负责人阶段 4 裁定）：一行静态提示；断网读屏只播一次，网回来也只说一次；网络来回跳时不一闪一闪 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { OFFLINE_NOTE, ONLINE_AGAIN } from '@/chat/online';
import { Thread } from '@/chat/Thread';
import { newConversation } from '@/chat/store';

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

  /** 数整页所有播报区（role=status 或 aria-live，读屏会播）里这句话一共出现了几次（每个状态区从没有到有算一次） */
  const countSpoken = (text: string) => {
    const seen = { n: 0 };
    const had = new WeakSet<Element>();
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')) {
        const has = el.textContent === text;
        if (has && !had.has(el)) seen.n += 1;
        if (has) had.add(el);
        else had.delete(el);
      }
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
    return seen;
  };

  it('断网：显示一行静态提示，读屏只播一次；网回来提示消失，也只说一次', async () => {
    renderPage();
    expect(document.querySelector('.offline-note')).toBeNull();
    const off = countSpoken(OFFLINE_NOTE);
    const on = countSpoken(ONLINE_AGAIN);

    setNet(false);
    await waitFor(() => expect(document.querySelector('.offline-note')?.textContent).toBe(OFFLINE_NOTE), { timeout: 4000 });
    // 静态的一行：本身不是播报区（播报只走整页那个状态区一次）
    const note = document.querySelector('.offline-note')!;
    expect(note.closest('[role="status"],[role="alert"],[aria-live]')).toBeNull();
    // 再来一次 offline 事件（浏览器会重复发）：不再播
    setNet(false);
    await sleep(2000);
    expect(off.n).toBe(1);

    setNet(true);
    await waitFor(() => expect(document.querySelector('.offline-note')).toBeNull(), { timeout: 4000 });
    await waitFor(() => expect(on.n).toBe(1), { timeout: 2000 });
    setNet(true);
    await sleep(2000);
    expect(on.n).toBe(1);
    expect(off.n).toBe(1);
  }, 15000);

  it('网络来回跳（一秒内断了又回来）：不显示提示，也不播报', async () => {
    renderPage();
    const off = countSpoken(OFFLINE_NOTE);
    const on = countSpoken(ONLINE_AGAIN);
    setNet(false);
    await sleep(300);
    setNet(true);
    await sleep(300);
    setNet(false);
    await sleep(300);
    setNet(true);
    await sleep(2500);
    expect(document.querySelector('.offline-note')).toBeNull();
    expect(off.n).toBe(0);
    expect(on.n).toBe(0);
  }, 10000);

  it('打开页面时就是断网：直接显示提示（不等事件）', () => {
    online = false;
    renderPage();
    expect(document.querySelector('.offline-note')?.textContent).toBe(OFFLINE_NOTE);
  });

  it('同时挂着两个对话（一个在后台）：断网时整页只播一次，两个对话都只显示那行字、自己不播', async () => {
    render(
      <MemoryRouter>
        <ChatPage />
        <Thread conversation={newConversation()} onMessages={() => undefined} hidden offline={!online} />
      </MemoryRouter>,
    );
    const off = countSpoken(OFFLINE_NOTE);
    setNet(false);
    await waitFor(() => expect(off.n).toBe(1), { timeout: 4000 });
    await sleep(1500);
    expect(off.n).toBe(1);
    // 对话自己的状态区里没有这句
    for (const el of document.querySelectorAll('.chat-viewport ~ p[role="status"]')) expect(el.textContent).not.toBe(OFFLINE_NOTE);
  }, 10000);
});
