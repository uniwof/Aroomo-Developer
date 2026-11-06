import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { App } from '@/App';
import { COOKIE_SESSION, session } from '@/lib/api';
import { loadConversations, loadPrefs, parseEvent, splitSse, streamChat, type Conversation } from '@/chat/store';
// 这组测试测的是阶段 2/3 开关打开后的行为（以后验收、打开时用）。阶段 1.5 发布默认全关，关着的样子见 release-15-flags-off.test.tsx
vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false } }));

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
        if (url === '/api/assistants') return new Response(JSON.stringify({ assistants: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
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

  it('中等宽度（48–64em）：窄栏 + 对话，会话列表是一层抽屉，没有标签页；设置照 sumus 是居中弹窗（左边分组），成员在主区域原地打开；字号可调大并记住', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
    try {
      renderPage();
      expect(document.querySelectorAll('dialog')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: /打开菜单/ }));
      const d = document.querySelector('dialog')!;
      await waitFor(() => expect(d.hasAttribute('open')).toBe(true));
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      // 抽屉里只放会话列表（自审 B15：不再和窄栏重复一排分类）
      expect(within(d).queryByRole('button', { name: '设置' })).toBeNull();
      fireEvent.click(within(d).getByRole('button', { name: '关闭菜单' }));
      await waitFor(() => expect(d.hasAttribute('open')).toBe(false));
      fireEvent.click(within(screen.getByRole('navigation', { name: '分类' })).getByRole('button', { name: '设置' }));
      expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
      // 照 sumus 先打开「个人资料」，字号在「偏好」里
      fireEvent.click(within(screen.getByRole('list', { name: '设置分组' })).getByRole('button', { name: '偏好' }));
      // 调到 15：900 宽仍在 48–64em 之间（再大就自动切成手机排法，见下一条测试）
      fireEvent.change(screen.getByRole('slider', { name: /字号/ }), { target: { value: '15' } });
      expect(loadPrefs().fontSize).toBe(15);
      const set = screen.getByRole('dialog', { name: '设置' });
      expect(within(set).getByRole('list', { name: '设置分组' })).toBeInTheDocument();
      fireEvent.click(within(set).getByRole('button', { name: '关闭设置' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull());
      fireEvent.click(within(screen.getByRole('navigation', { name: '分类' })).getByRole('button', { name: '成员' }));
      fireEvent.click(await screen.findByRole('button', { name: /^Kimi/ }));
      fireEvent.click(await screen.findByRole('button', { name: '在当前对话里点名 Kimi' }));
      await waitFor(() => expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toContain('@Kimi '));
      expect(document.querySelectorAll('dialog')).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    }
  });

  it('桌面：分类窄栏 + 会话列表 + 对话常显；助手没有预置、只有一句空状态；新建菜单：默认全员 / 挑选成员 / 和某位单聊；铃铛打开收件箱', async () => {
    document.documentElement.style.fontSize = '';
    renderPage();
    expect(document.querySelectorAll('dialog')).toHaveLength(0);
    expect(screen.getByRole('navigation', { name: '分类' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '助手' }));
    expect(screen.getByText(/^还没有助手。/)).toBeInTheDocument();
    // integrate/stage2：助手开关打开，所有者在「助手」分段里有「新建助手」和「看全部计划」（接 /api/assistants）
    expect(screen.getByRole('button', { name: '新建助手' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '看全部计划' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '对话' }));
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    expect(screen.getByRole('button', { name: '新对话（全员）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '挑选成员新建' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '和 Kimi 开新对话' }));
    expect(screen.getByRole('heading', { name: 'Kimi' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^通知和收件箱/ }));
    expect((await screen.findAllByRole('heading', { name: /收件箱/ })).length).toBeGreaterThan(0);
  });

  it('@ 点名（自审 A1）：输入 @ 弹出列表，焦点留在输入框，↓/回车选中成员，不把光秃秃的「@」发出去；Esc 关', async () => {
    renderPage();
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => u === '/api/members')).toBe(true));
    await new Promise((r) => setTimeout(r, 500));
    const box = screen.getByLabelText('输入消息') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@' } });
    const list = await screen.findByRole('listbox', { name: '点名一位成员' });
    expect(within(list).getByRole('option', { name: '点名 Kimi' })).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', 'mention-0');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('@Kimi '));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(f.mock.calls.some(([u]) => String(u).includes('/chat'))).toBe(false);
    fireEvent.change(box, { target: { value: '@Kimi 你好 ' } });
    fireEvent.change(box, { target: { value: '@Kimi 你好 @' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('家人账号（自审 A3）：窄栏、会话栏底部不显示 资源库/工具/API；设置只有 个人资料·偏好·安全·键盘快捷键；旧链接 ?view=keys 不打开', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '小明', role: 'user' }));
    try {
      render(
        <MemoryRouter initialEntries={['/chat?view=keys']}>
          <ChatPage />
        </MemoryRouter>,
      );
      const rail = screen.getByRole('navigation', { name: '分类' });
      for (const n of ['资源库', '工具', 'API']) expect(within(rail).queryByRole('button', { name: n })).toBeNull();
      expect(screen.queryByRole('button', { name: '打开资源库' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'API' })).toBeNull();
      fireEvent.click(within(rail).getByRole('button', { name: '设置' }));
      const nav = within(screen.getByRole('dialog', { name: '设置' })).getByRole('list', { name: '设置分组' });
      expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['个人资料', '偏好', '安全', '键盘快捷键']);
    } finally {
      sessionStorage.removeItem('aroomo.console.user');
    }
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

  it('默认字号 = sumus 原样（正文 14px，根字号不改）', () => {
    const { container } = renderPage();
    expect(container.querySelector('.app')).not.toBeNull();
    expect(document.documentElement.style.fontSize).toBe('');
  });

  it('自审 B16：内容滚到顶栏底下时顶栏出现分隔线，滚回顶部就没有', () => {
    const { container } = renderPage();
    const main = container.querySelector('main.main') as HTMLElement;
    const inner = document.createElement('div');
    main.appendChild(inner);
    expect(main.hasAttribute('data-scrolled')).toBe(false);
    inner.scrollTop = 40;
    fireEvent.scroll(inner);
    expect(main.hasAttribute('data-scrolled')).toBe(true);
    inner.scrollTop = 0;
    fireEvent.scroll(inner);
    expect(main.hasAttribute('data-scrolled')).toBe(false);
    inner.remove();
  });

  it('手机（<48em）照 sumus：不用抽屉，整页列表 + 底部栏「对话 / 成员 / 我」，进对话后底部栏藏起来', () => {
    const w0 = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      const { container } = renderPage();
      expect(container.querySelector('dialog')).toBeNull();
      expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
      // Poke ③：手机对话页的返回键和面板一样是「← 对话」（看得见文字），不是光秃秃的箭头
      const back = screen.getByRole('button', { name: '返回对话列表' });
      expect(back.textContent).toBe('对话');
      expect(back.classList.contains('back-btn')).toBe(true);
      fireEvent.click(back);
      const nav = screen.getByRole('navigation', { name: '主导航' });
      expect(nav.querySelectorAll('button')).toHaveLength(3);
      expect(within(nav).getByRole('button', { name: '对话' }).getAttribute('aria-current')).toBe('page');
      fireEvent.click(within(nav).getByRole('button', { name: /^我：/ }));
      fireEvent.click(within(screen.getByRole('list', { name: '我' })).getByRole('button', { name: '设置' }));
      expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
      // 手机设置是整页：先分组列表，点进去看详情，← 回到分组列表（不用横向标签）
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '偏好' }));
      expect(screen.getByText('改动立即生效，不用保存。')).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /字号/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
      fireEvent.click(screen.getByRole('button', { name: '返回我' }));
      expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w0 });
    }
  });

  it('只有图标的按钮都有读屏名字（负责人落地文档 15 章必带测试）', () => {
    const { container } = renderPage();
    const bad = [...container.querySelectorAll('button')].filter((b) => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label'));
    expect(bad.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
  });
});
