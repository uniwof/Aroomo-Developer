/**
 * 阶段 1.5 发布（负责人裁定 B，2026-11-06）：阶段 2/3 的六个开关在发布提交上全关（taskCards、convFilter、schedulePage、
 * assistantDraft、assistants、savedChats）。这里用真开关（不 mock），测关着时：
 * 1. Core 仍回草稿数据块时，聊天照常显示文字回复，不出草稿卡、不空白、不报错；
 * 2. 侧栏搜索照常按标题搜本机会话，不去 Core 搜消息、不报错；
 * 3. 没有助手入口、不请求 /api/assistants、/api/conversations。
 * Core 侧 COMPACT_ENABLED 不写 = 不压缩，见 core/test/conversations-compact.test.ts。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { saveConversations, type Conversation } from '@/chat/store';
import { FLAGS } from '@/lib/flags';
import type { Member } from '@/lib/api';

const enc = new TextEncoder();
const sse = (objs: unknown[]) => objs.map((o) => (o === 'DONE' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`)).join('');
const stream = (body: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
  );
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const M = (id: string, name: string): Member => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }) as unknown as Member;

const REPLY = '好的，每天早上 8 点提醒你喝水。— 小A（负责人）';
// Core 不看前端开关：所有者说「每天早上提醒我…」时仍会带草稿数据块
const draftReply = sse([
  { type: 'start', messageId: 'm' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: REPLY },
  { type: 'text-end', id: 't' },
  {
    type: 'data-aroomo-assistant-draft',
    id: 'draft_placeholder-0002',
    data: { name: '喝水提醒', instructions: '提醒我喝水', members: ['m-a'], leadMemberId: 'm-a', schedule: { kind: 'daily', time: '08:00' }, timezone: 'Asia/Shanghai', budgetLevel: 'low', nextRunAt: null, scheduleText: '每天 08:00' },
  },
  { type: 'finish' },
  'DONE',
]);

let calls: Array<{ method: string; url: string }>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url === '/api/chat/stream') return stream(draftReply);
      if (url === '/api/members') return json({ members: [M('m-a', '小A')] });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );
const hit = (prefix: string) => calls.some((c) => c.url.startsWith(prefix));

describe('阶段 1.5：阶段 2/3 开关关着', () => {
  it('六个开关确实是关的（真开关，不 mock）', () => {
    expect(FLAGS).toMatchObject({ taskCards: false, convFilter: false, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false });
  });

  it('assistantDraft 关：说「每天早上提醒我…」→ 照常显示文字回复，没有草稿卡、不空白、不报错', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '每天早上提醒我喝水' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(/每天早上 8 点提醒你喝水/, undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /助手草稿/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '建好' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(hit('/api/assistants')).toBe(false);
    expect(hit('/api/conversations')).toBe(false); // savedChats 关：不去 Core 存会话
  });

  it('savedChats 关：侧栏搜索照常按标题搜本机会话，不去 Core 搜消息、不报错', async () => {
    const now = Date.now();
    const conv = (id: string, title: string, at: number): Conversation => ({ id, title, model: 'aroomo', messages: [{ role: 'user', text: title, at }], updatedAt: at });
    saveConversations([conv('c-1', '周末买菜清单', now), conv('c-2', '体检报告怎么看', now - 1000)]);
    renderPage();
    const list = await screen.findByRole('list', { name: '会话列表' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索对话' }), { target: { value: '体检' } });
    await waitFor(() => expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '').join('|')).toMatch(/体检报告怎么看/));
    expect(within(list).queryByRole('button', { name: /周末买菜清单/ })).toBeNull();
    // 没有「消息」那组（那是 Core 存库后的 X-09）
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('region', { name: '消息里找到的' })).toBeNull();
    expect(hit('/api/search')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    // 搜不到：一句「没有找到」
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索对话' }), { target: { value: '没有的词' } });
    expect(await within(list).findByText('没有找到。换个词试试。')).toBeInTheDocument();
  });

  it('assistants / schedulePage 关：没有「助手」入口、没有「看全部计划」，也不请求 /api/assistants', async () => {
    renderPage();
    await screen.findByRole('list', { name: '会话列表' });
    expect(screen.queryByRole('button', { name: /看全部计划/ })).toBeNull();
    expect(screen.queryByRole('list', { name: '助手列表' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '助手' })).toBeNull(); // 「对话 / 助手」分段里没有「助手」
    expect(screen.queryByRole('button', { name: '新建助手' })).toBeNull();
    expect(hit('/api/assistants')).toBe(false);
  });
});
