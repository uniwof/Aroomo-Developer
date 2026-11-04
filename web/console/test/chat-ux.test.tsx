/** #250 对标改进（ChatGPT / Claude / LibreChat / Open WebUI 的成熟做法）：出错重试、草稿、说话人、建议、整页字号、主题、快捷键 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { NETWORK_ERROR, loadDraft, saveDraft, signatureOf, streamChat } from '@/chat/store';
import { applyDisplay, readDisplayPrefs } from '@/lib/display';

const enc = new TextEncoder();
const sse = (objs: unknown[]) => objs.map((o) => (o === 'DONE' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`)).join('');
const uiStream = (deltas: string[]) =>
  sse([{ type: 'start', messageId: 'm' }, { type: 'text-start', id: 't' }, ...deltas.map((d) => ({ type: 'text-delta', id: 't', delta: d })), { type: 'text-end', id: 't' }, { type: 'finish' }, 'DONE']);
const okResponse = (body: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

describe('store 小工具', () => {
  it('署名「— 名字」→ 是谁回答的', () => {
    expect(signatureOf('你好\n\n— FreeBot')).toBe('FreeBot');
    expect(signatureOf('没有署名')).toBeNull();
    expect(signatureOf('a — b 中间的破折号不算\n继续')).toBeNull();
  });

  it('草稿：每个会话一份，清空就删', () => {
    localStorage.clear();
    saveDraft('c1', '还没写完');
    expect(loadDraft('c1')).toBe('还没写完');
    expect(loadDraft('c2')).toBe('');
    saveDraft('c1', '  ');
    expect(loadDraft('c1')).toBe('');
  });

  it('断网：给人看的话，不露浏览器英文报错', async () => {
    const f = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(streamChat([{ role: 'user', text: 'x' }], 'aroomo', new AbortController().signal, f).next()).rejects.toThrow(NETWORK_ERROR);
  });

  it('字号和主题作用到整页 <html>', () => {
    const root = document.createElement('html');
    applyDisplay({ fontSize: 24, theme: 'dark' }, root);
    expect(root.style.fontSize).toBe('24px');
    expect(root.classList.contains('dark')).toBe(true);
    applyDisplay({ fontSize: 16, theme: 'system' }, root);
    expect(root.style.fontSize).toBe('');
    expect(root.classList.contains('dark')).toBe(false);
  });
});

describe('对话页：对标改进', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/members')
          return new Response(JSON.stringify({ members: [{ id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        return new Response('{}', { status: 404 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    applyDisplay({ fontSize: 16, theme: 'system' });
  });

  const renderPage = (fetchImpl?: typeof fetch) =>
    render(
      <MemoryRouter>
        <ChatPage {...(fetchImpl ? { fetchImpl } : {})} />
      </MemoryRouter>,
    );

  it('出错：就地显示原因 + 「重试」；重试成功后保留原话、出回复', async () => {
    let n = 0;
    const chatFetch = (async () => {
      n += 1;
      if (n === 1) return new Response('{}', { status: 429 });
      return okResponse(uiStream(['好了\n\n— Kimi']));
    }) as unknown as typeof fetch;
    const { container } = renderPage(chatFetch);
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '在吗' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('说得太快了，请稍等一下再发。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试这条回复' }));
    await waitFor(() => expect(container.textContent).toContain('好了'), { timeout: 8000 });
    expect(n).toBe(2);
    expect(container.querySelector('.msg-body-user')?.textContent).toBe('在吗');
    // 读屏能听到是谁说的
    expect(screen.getByText('你说：')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Kimi 回复：')).toBeInTheDocument());
  });

  it('空状态建议：点了放进输入框，不自动发', async () => {
    const chatFetch = vi.fn();
    renderPage(chatFetch as unknown as typeof fetch);
    fireEvent.click(screen.getByRole('button', { name: '你能帮我做什么？' }));
    await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('你能帮我做什么？'));
    expect(chatFetch).not.toHaveBeenCalled();
  });

  it('草稿：没发出去的话，重新打开还在', async () => {
    const { unmount } = renderPage();
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '写到一半' } });
    unmount();
    renderPage();
    await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('写到一半'));
  });

  it('设置：字号放大到整页、可选深色；快捷键说明能读到（齿轮打开，分组列表，不用标签页）', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: '28' }));
    expect(document.documentElement.style.fontSize).toBe('28px');
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(readDisplayPrefs()).toEqual({ fontSize: 28, theme: 'dark' });
    fireEvent.click(screen.getByRole('button', { name: '键盘快捷键' }));
    expect(screen.getByText('回到输入框')).toBeInTheDocument();
  });

  it('快捷键：Ctrl+Shift+S 开关会话列表（手机宽度是抽屉）；Ctrl+Shift+O 新对话', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    try {
      renderPage();
      const d = document.querySelector('dialog')!;
      fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(d.hasAttribute('open')).toBe(true));
      fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(d.hasAttribute('open')).toBe(false));
      fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
      expect(document.title).toBe('新对话 · Aroomo');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    }
  });

  it('停止：上游请求被中断，已收到的部分保留，读屏播报「已停止」', async () => {
    let signal: AbortSignal | undefined;
    const chatFetch = (async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(sse([{ type: 'text-delta', id: 't', delta: '先说一半' }])));
            init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { container } = renderPage(chatFetch);
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '讲个长故事' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(container.textContent).toContain('先说一半'));
    fireEvent.click(screen.getByRole('button', { name: '停止回复' }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已停止，收到的部分保留了'));
    expect(container.textContent).toContain('先说一半');
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
  });

  it('打开旧会话：历史消息照常显示', async () => {
    localStorage.setItem(
      'aroomo.chat.v1',
      JSON.stringify([{ id: 'c9', title: '旧会话', model: 'aroomo', updatedAt: 1, messages: [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '旧回答' }] }]),
    );
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('旧回答'));
    expect(container.querySelector('.msg-body-user')?.textContent).toBe('旧问题');
  });
});
