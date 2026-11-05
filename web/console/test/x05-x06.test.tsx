/**
 * X-05 工具调用过程可见 + X-06 分工的送达状态（docs/api/stream-parts.md）。
 * - data-aroomo-tool：解析、同 index 覆盖、回复正文上方一行灰字，点开看详情（所有者有参数和结果摘录，家人只有摘要）；刷新后还在。
 * - 任务卡：成员那一步按 已派出 → 已收到 → 在做 → 已回复 显示，组长那几步照旧。
 * 假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { asTool, asTools, loadConversations, parseEvent, streamChat, upsertTool, type ChatTool } from '@/chat/store';
import { ToolCalls, toolLine } from '@/chat/thread/cards/ToolCalls';
import { TaskCard, progressText } from '@/chat/thread/cards/TaskCard';
import { stepsToTask } from '@/chat/pages/assistants/AssistantPages';
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
const members = [M('m-a', '小A'), M('m-b', '小B')];

const SEARCH: ChatTool = { index: 0, name: 'search', label: '搜了网页', state: 'done', count: 5, summary: '5 条结果', args: '{"query":"免费模型","api_key":"【已隐藏】"}', result: '第一条 https://a.test/p?…' };
const READ: ChatTool = { index: 1, name: 'read_webpage', label: '读了网页', state: 'unavailable', summary: '这个工具还没有开放给成员，没有执行' };
const toolReply = sse([
  { type: 'start', messageId: 'm' },
  { type: 'text-start', id: 't' },
  { type: 'data-aroomo-tool', id: 'm_tool_0', data: { ...SEARCH, state: 'failed', summary: '没有拿到结果', count: undefined, result: undefined } },
  { type: 'text-delta', id: 't', delta: '找到 5 个新的免费模型。\n\n— 小A（负责人）' },
  { type: 'text-end', id: 't' },
  { type: 'data-aroomo-tool', id: 'm_tool_0', data: SEARCH },
  { type: 'finish' },
  'DONE',
]);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/chat/stream') return stream(toolReply);
      if (url === '/api/members') return json({ members });
      if (url === '/api/assistants') return json({ assistants: [] });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('X-05 数据块', () => {
  it('parseEvent 认出 data-aroomo-tool；缺字段、状态不认识、index 不是整数的不认', () => {
    expect(parseEvent(`data: ${JSON.stringify({ type: 'data-aroomo-tool', id: 'x', data: SEARCH })}`)).toEqual({ type: 'tool', tool: SEARCH });
    expect(asTool({ ...SEARCH, state: 'running' })).toBeNull();
    expect(asTool({ ...SEARCH, index: 1.5 })).toBeNull();
    expect(asTool({ index: 0, name: 'x' })).toBeNull();
    // 家人账号：没有参数和结果
    expect(asTool({ index: 0, name: 'search', label: '搜了网页', state: 'done', summary: '5 条结果' })).toEqual({ index: 0, name: 'search', label: '搜了网页', state: 'done', summary: '5 条结果' });
    expect(asTools([SEARCH, null, 'x', READ])).toEqual([SEARCH, READ]);
  });

  it('同一个 index 覆盖、按 index 排序；streamChat 把每次的工具数据交给 onTool，文字照常', async () => {
    expect(upsertTool([READ, { ...SEARCH, state: 'failed' }], SEARCH)).toEqual([SEARCH, READ]);
    const got: ChatTool[] = [];
    let text = '';
    const f = (async () => stream(toolReply)) as unknown as typeof fetch;
    for await (const t of streamChat([{ role: 'user', text: 'x' }], 'aroomo', new AbortController().signal, f, undefined, {}, (t) => got.push(t))) text = t;
    expect(got.map((t) => t.state)).toEqual(['failed', 'done']);
    expect(text).toMatch(/^找到 5 个/);
  });

  it('收起时一行：一个工具「搜了网页 · 5 条结果」，几个工具「用了 2 个工具 · 搜了网页、读了网页」', () => {
    expect(toolLine([SEARCH])).toBe('搜了网页 · 5 条结果');
    expect(toolLine([SEARCH, READ])).toBe('用了 2 个工具 · 搜了网页、读了网页');
  });
});

describe('X-05 工具调用行', () => {
  it('默认收起（aria-expanded=false，读屏名字以「工具调用：」开头）；点开逐个列出，所有者能看参数和结果摘录；再点收起', () => {
    render(<ToolCalls tools={[SEARCH, READ]} />);
    const btn = screen.getByRole('button', { name: /^工具调用：用了 2 个工具/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('结果摘录')).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: '工具调用详情' });
    expect(btn).toHaveAttribute('aria-controls', list.id);
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]!).getByText('完成')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/"api_key":"【已隐藏】"/)).toBeInTheDocument();
    expect(within(items[0]!).getByText('第一条 https://a.test/p?…')).toBeInTheDocument();
    expect(within(items[1]!).getByText('没执行')).toBeInTheDocument();
    expect(within(items[1]!).getByText('这个工具还没有开放给成员，没有执行')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('list', { name: '工具调用详情' })).not.toBeInTheDocument();
  });

  it('家人账号（Core 只给摘要）：点开只有摘要，没有「参数」「结果摘录」', () => {
    render(<ToolCalls tools={[{ index: 0, name: 'search', label: '搜了网页', state: 'done', count: 5, summary: '5 条结果' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /^工具调用：搜了网页 · 5 条结果/ }));
    expect(screen.getAllByText('5 条结果').length).toBeGreaterThan(0);
    expect(screen.queryByText(/参数/)).not.toBeInTheDocument();
    expect(screen.queryByText('结果摘录')).not.toBeInTheDocument();
  });

  it('聊天里：回复正文上方出现工具行（同一个调用只一行，显示最终状态）；存进本机后刷新还在', async () => {
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '帮我搜一下新的免费模型' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const btn = await screen.findByRole('button', { name: /^工具调用：搜了网页 · 5 条结果/ }, { timeout: 8000 });
    expect(screen.getAllByRole('button', { name: /^工具调用：/ })).toHaveLength(1);
    // 在正文上方：文档顺序里先于回复正文
    const body = (await screen.findAllByText(/找到 5 个新的免费模型/)).find((el) => el.closest('.msg-body'))!;
    expect(btn.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await vi.waitFor(() => expect(loadConversations()[0]?.messages.find((m) => m.role === 'assistant')?.tools).toEqual([SEARCH]), { timeout: 8000 });
  }, 30_000);
});

describe('X-06 送达状态', () => {
  const step = (stepNo: number, memberId: string | null, action: 'plan' | 'work' | 'summarize', status: 'pending' | 'received' | 'running' | 'done' | 'failed', detail = '') => ({ stepNo, memberId, action, status, detail, startedAt: '', updatedAt: '' });

  it('成员那一步：pending → 已派出、received → 已收到、running → 在做、done → 已回复；组长那几步照旧（等待 / 进行中 / 完成）', () => {
    const t = stepsToTask(
      [
        step(0, 'm-a', 'plan', 'done'),
        step(1, 'm-b', 'work', 'pending', '去查 A 站'),
        step(2, 'm-b', 'work', 'received', '去查 B 站'),
        step(3, 'm-b', 'work', 'running', '去查 C 站'),
        step(4, 'm-b', 'work', 'done', '找到 3 条'),
        step(5, 'm-b', 'work', 'failed', 'Key 无效'),
        step(6, 'm-a', 'summarize', 'pending'),
      ],
      members,
    );
    expect(t.map((s) => s.status)).toEqual(['done', 'sent', 'received', 'working', 'replied', 'failed', 'waiting']);
    expect(progressText(t)).toBe('7 步，完成 2 步');
  });

  it('任务卡上读得出每一步卡在哪：小B · 做事：去查 B 站 · 已收到', () => {
    const t = stepsToTask([step(0, 'm-a', 'plan', 'done'), step(1, 'm-b', 'work', 'received', '去查 B 站'), step(2, 'm-b', 'work', 'pending', '去查 C 站')], members);
    render(<TaskCard title="资源周报 · 运行中" steps={t} />);
    const items = within(screen.getByRole('list', { name: '步骤' })).getAllByRole('listitem');
    expect(items[1]).toHaveTextContent('小B · 做事：去查 B 站已收到');
    expect(items[2]).toHaveTextContent('已派出');
  });
});
