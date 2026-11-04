import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { App } from '@/App';
import { COOKIE_SESSION, session } from '@/lib/api';
import { loadConversations, loadPrefs, parseEvent, splitSse, streamChat, withGroupMentions, type Conversation } from '@/chat/store';

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
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
  );

describe('对话流解析（AI SDK UI Message Stream）', () => {
  it('拆事件、认 text-delta / error / finish / [DONE]', () => {
    const { events, rest } = splitSse('data: {"type":"text-delta","delta":"a"}\n\ndata: [DO');
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: [DO');
    expect(parseEvent(events[0]!)).toEqual({ type: 'delta', text: 'a' });
    expect(parseEvent('data: [DONE]')).toEqual({ type: 'done' });
    expect(parseEvent('data: {"type":"error","errorText":"坏了"}')).toEqual({ type: 'error', text: '坏了' });
    expect(parseEvent('data: {"type":"start"}')).toBeNull();
  });

  it('streamChat：只用 Cookie + X-Aroomo-Request，不带 Authorization；逐段累加', async () => {
    sessionStorage.setItem('aroomo.console.session', 'placeholder-should-not-be-sent');
    const calls: RequestInit[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      calls.push(init);
      return okResponse(uiStream(['你', '好']));
    }) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const t of streamChat([{ role: 'user', text: 'hi' }], 'aroomo', new AbortController().signal, f)) out.push(t);
    expect(out).toEqual(['你', '你好']);
    const h = calls[0]!.headers as Record<string, string>;
    expect(h['x-aroomo-request']).toBe('1');
    expect(h.authorization).toBeUndefined();
    expect(calls[0]!.credentials).toBe('same-origin');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ model: 'aroomo', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('服务端拒绝 / 流里出错：抛出给人看的话', async () => {
    const f401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(streamChat([{ role: 'user', text: 'x' }], 'aroomo', new AbortController().signal, f401).next()).rejects.toThrow('登录已过期');
    const fErr = (async () => okResponse(sse([{ type: 'error', errorText: '对话出错了，请稍后再试。' }, 'DONE']))) as unknown as typeof fetch;
    await expect(streamChat([{ role: 'user', text: 'x' }], 'aroomo', new AbortController().signal, fErr).next()).rejects.toThrow('对话出错了');
  });

  it('群聊：没写 @ 时自动 @ 群里的成员；写了 @ 就按用户的', () => {
    expect(withGroupMentions('大家好', ['A', 'B'])).toBe('@A @B 大家好');
    expect(withGroupMentions('@A 你说', ['A', 'B'])).toBe('@A 你说');
    expect(withGroupMentions('hi', undefined)).toBe('hi');
  });
});

describe('原生对话页', () => {
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
  });

  const renderPage = (fetchImpl?: typeof fetch) =>
    render(
      <MemoryRouter>
        <ChatPage {...(fetchImpl ? { fetchImpl } : {})} />
      </MemoryRouter>,
    );

  it('发一句话：回复逐段显示，结束后存进本机；HTML 不会被渲染成元素', async () => {
    const chatFetch = (async () => okResponse(uiStream(['**好的**', '，<img src=x onerror="alert(1)">', '\n\n```js\nconsole.log(1)\n```']))) as unknown as typeof fetch;
    const { container } = renderPage(chatFetch);
    const input = screen.getByLabelText('输入消息');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    // Markdown 引擎按需加载：先出纯文字，引擎到了再排版
    await waitFor(() => expect(screen.getByText('好的')).toBeInTheDocument(), { timeout: 8000 });
    expect(container.querySelector('img')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '复制代码' })).toBeInTheDocument());
    await waitFor(() => expect(loadConversations()).toHaveLength(1));
    const c = loadConversations()[0] as Conversation;
    expect(c.title).toBe('你好');
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  }, 20000);

  it('手机：只有一层抽屉（会话列表栏），没有标签页；设置、成员都在主区域原地打开；字号可调大并记住', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    try {
      renderPage();
      expect(document.querySelectorAll('dialog')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: /打开菜单/ }));
      const d = document.querySelector('dialog')!;
      await waitFor(() => expect(d.hasAttribute('open')).toBe(true));
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      // 置顶的 Aroomo 系统会话 = 收件箱
      fireEvent.click(screen.getByRole('button', { name: '设置' }));
      await waitFor(() => expect(d.hasAttribute('open')).toBe(false));
      expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
      fireEvent.change(screen.getByRole('slider', { name: /字号/ }), { target: { value: '24' } });
      expect(loadPrefs().fontSize).toBe(24);
      fireEvent.click(screen.getByRole('button', { name: /打开菜单/ }));
      fireEvent.click(screen.getByRole('button', { name: '成员' }));
      fireEvent.click(await screen.findByRole('button', { name: /^Kimi/ }));
      fireEvent.click(await screen.findByRole('button', { name: '在当前对话里点名 Kimi' }));
      await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toContain('@Kimi '));
      expect(document.querySelectorAll('dialog')).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    }
  });

  it('桌面：分类窄栏 + 会话列表 + 对话常显；专职成员列表里点成员就单聊；铃铛打开收件箱', async () => {
    document.documentElement.style.fontSize = '';
    renderPage();
    expect(document.querySelectorAll('dialog')).toHaveLength(0);
    expect(screen.getByRole('navigation', { name: '分类' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '专职成员' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Kimi/ }));
    expect(screen.getByRole('heading', { name: 'Kimi' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^通知和收件箱/ }));
    expect((await screen.findAllByRole('heading', { name: /收件箱/ })).length).toBeGreaterThan(0);
  });

  it('打开 Aroomo（/）直接进对话', async () => {
    session.set(COOKIE_SESSION);
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    session.set(null);
  });

  it('默认字号 16px', () => {
    const { container } = renderPage();
    expect(container.querySelector('.app')).not.toBeNull();
    expect(document.documentElement.style.fontSize).toBe('');
  });
});
