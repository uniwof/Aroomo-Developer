/**
 * X-15 聊天里的助手草稿卡（design-assistants-v1 §7.6）+ 前端幂等键。
 * 她在负责人对话里说「每周一早上 9 点帮我…」→ Core 回一句话 + data-aroomo-assistant-draft → 对话里出现草稿卡；
 * 只有点「建好」才 POST /api/assistants（带 Idempotency-Key = 卡的 id）；「改一改」打开预先填好的新建助手弹窗；「不用了」收起。
 * 家人账号即使收到数据块也不显示卡。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { asDraft, loadConversations, parseEvent, streamChat, type ChatDraft } from '@/chat/store';
import { formFromInput } from '@/chat/pages/assistants/AssistantPages';
import { inputFromDraft } from '@/chat/pages/assistants/ChatDraftCard';
import { api, type Member } from '@/lib/api';
import { assistantsApi } from '@/lib/assistants';
// 这组测试测的是阶段 2/3 开关打开后的行为（以后验收、打开时用）。阶段 1.5 发布默认全关，关着的样子见 release-15-flags-off.test.tsx
vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false } }));

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

const DATA: ChatDraft['data'] = {
  name: '找新的免费模型',
  instructions: '找新的免费模型，筛好告诉我',
  members: ['m-a'],
  leadMemberId: 'm-a',
  schedule: { kind: 'weekly', time: '09:00', days: [1] },
  timezone: 'Asia/Shanghai',
  budgetLevel: 'low',
  nextRunAt: '2026-11-09T01:00:00.000Z',
  scheduleText: '每周一 09:00',
};
const DRAFT_ID = 'draft_placeholder-0001';
const draftReply = sse([
  { type: 'start', messageId: 'm' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: '我拟了一个助手，你看看对不对。点「建好」才会真的建；想调整点「改一改」，不要就点「不用了」。\n\n— 小A（负责人）' },
  { type: 'text-end', id: 't' },
  { type: 'data-aroomo-assistant-draft', id: DRAFT_ID, data: DATA },
  { type: 'finish' },
  'DONE',
]);

let calls: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url === '/api/chat/stream') return stream(draftReply);
      if (url === '/api/members') return json({ members });
      if (url === '/api/assistants' && method === 'GET') return json({ assistants: [] });
      if (url === '/api/assistants' && method === 'POST') return json({ assistant: { id: 'a9', name: '找新的免费模型' }, created: true }, 201);
      if (url === '/api/assistants/preview') return json({ scheduleText: '每周三 15:00', nextRunAt: null, nextRunText: '', part: { type: 'data-aroomo-assistant-draft', data: { ...DATA, schedule: { kind: 'weekly', time: '15:00', days: [3] } } } });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );
async function ask() {
  renderPage();
  fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '每周一早上 9 点帮我找新的免费模型，筛好告诉我' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  return screen.findByRole('region', { name: '助手草稿：找新的免费模型' }, { timeout: 8000 });
}
const posts = () => calls.filter((c) => c.url === '/api/assistants' && c.method === 'POST');

describe('草稿数据块解析', () => {
  it('parseEvent 认出草稿卡；缺字段 / id 不合规的不认（不渲染半张卡）', () => {
    expect(parseEvent(`data: ${JSON.stringify({ type: 'data-aroomo-assistant-draft', id: DRAFT_ID, data: DATA })}`)).toEqual({ type: 'draft', draft: { id: DRAFT_ID, data: DATA } });
    expect(parseEvent(`data: ${JSON.stringify({ type: 'data-aroomo-assistant-draft', id: DRAFT_ID, data: { name: 'x' } })}`)).toBeNull();
    expect(asDraft({ id: 'bad id with spaces', data: DATA })).toBeNull();
    expect(asDraft({ id: DRAFT_ID, data: DATA, state: 'weird' })).toEqual({ id: DRAFT_ID, data: DATA });
  });

  it('streamChat 把草稿卡交给 onDraft，文字照常累加', async () => {
    const got: ChatDraft[] = [];
    const out: string[] = [];
    const f = (async () => stream(draftReply)) as unknown as typeof fetch;
    for await (const t of streamChat([{ role: 'user', text: 'x' }], 'aroomo', new AbortController().signal, f, (d) => got.push(d))) out.push(t);
    expect(got).toEqual([{ id: DRAFT_ID, data: DATA }]);
    expect(out.at(-1)).toMatch(/点「建好」才会真的建/);
  });

  it('卡上的数据 → 建助手的请求体只带接口认的字段；不在预设里的计划在弹窗里多一个「聊天里说的」选项', () => {
    const input = inputFromDraft({ ...DATA, schedule: { kind: 'weekly', time: '15:00', days: [3], text: '每周三 15:00' } });
    expect(input).toEqual({ name: DATA.name, instructions: DATA.instructions, members: ['m-a'], leadMemberId: 'm-a', schedule: { kind: 'weekly', time: '15:00', days: [3] }, timezone: 'Asia/Shanghai', budgetLevel: 'low' });
    const { form, options } = formFromInput(input, members);
    expect(form).toMatchObject({ name: DATA.name, members: ['m-a'], lead: 'm-a', scheduleId: 'chat' });
    expect(options.at(-1)).toMatchObject({ id: 'chat', label: '每周三 15:00（聊天里说的）' });
    // 预设里有的计划：直接选中预设，不多加选项
    expect(formFromInput(inputFromDraft(DATA), members).form.scheduleId).toBe('monday-9');
    // 草稿里的成员不是她的：不带
    expect(formFromInput({ ...input, members: ['m-x'], leadMemberId: 'm-x' }, members).form).toMatchObject({ members: [], lead: '' });
  });
});

describe('X-15 聊天里的草稿卡', () => {
  it('说「每周一早上 9 点帮我…」→ 负责人回草稿卡；没点之前不建；「建好」才 POST，带幂等键 = 卡的 id；刷新后卡显示已建', async () => {
    const card = await ask();
    expect(within(card).getByText(/每周一 09:00/)).toBeInTheDocument();
    expect(within(card).getByText('小A')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(card).getByRole('button', { name: '建好' }));
    expect(await within(card).findByRole('status')).toHaveTextContent('已建好「找新的免费模型」');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.headers['idempotency-key']).toBe(DRAFT_ID);
    expect(posts()[0]!.body).toEqual(inputFromDraft(DATA));
    await waitFor(() => expect(loadConversations()[0]?.messages.at(-1)?.draft?.state).toBe('done'));
    // 刷新：卡还在，但已经不能再点「建好」
    cleanup();
    renderPage();
    const again = await screen.findByRole('region', { name: '助手草稿：找新的免费模型' }, { timeout: 8000 });
    expect(within(again).queryByRole('button', { name: '建好' })).toBeNull();
    expect(within(again).getByRole('status')).toHaveTextContent('已建好');
  });

  it('「不用了」：卡收起，不建', async () => {
    const card = await ask();
    fireEvent.click(within(card).getByRole('button', { name: '不用了' }));
    expect(within(card).getByRole('status')).toHaveTextContent('不用了，没有建');
    expect(posts()).toHaveLength(0);
    await waitFor(() => expect(loadConversations()[0]?.messages.at(-1)?.draft?.state).toBe('dismissed'));
  });

  it('「改一改」：打开新建助手弹窗，名字、任务、成员、计划都预先填好；预览后建好，原来那张卡也标成已建', async () => {
    const card = await ask();
    fireEvent.click(within(card).getByRole('button', { name: '改一改' }));
    const dlg = await screen.findByRole('dialog', { name: '新建助手' });
    expect(within(dlg).getByLabelText('名字（必填）')).toHaveValue('找新的免费模型');
    expect(within(dlg).getByLabelText('任务说明（必填）')).toHaveValue('找新的免费模型，筛好告诉我');
    expect(await within(dlg).findByRole('checkbox', { name: '小A' })).toBeChecked();
    expect(within(dlg).getByRole('radio', { name: '每周一 09:00' })).toBeChecked();
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole('button', { name: '预览' }));
    fireEvent.click(within(await within(dlg).findByRole('region', { name: '助手草稿：找新的免费模型' })).getByRole('button', { name: '建好' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    // 弹窗里的幂等键是这次预览的，不是聊天卡的
    expect(posts()[0]!.headers['idempotency-key']).toMatch(/^new-/);
    // 建好后跳到助手详情；聊天里那张卡记成已建（回到对话时不能再点「建好」）
    await waitFor(() => expect(loadConversations()[0]?.messages.at(-1)?.draft?.state).toBe('done'));
    expect(screen.queryByRole('dialog', { name: '新建助手' })).toBeNull();
  }, 15000);

  it('家人账号：就算收到数据块也不显示卡', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '小明', role: 'user' }));
    renderPage();
    fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: '每周一早上 9 点帮我找新的免费模型，筛好告诉我' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect((await screen.findAllByText(/点「建好」才会真的建/, {}, { timeout: 8000 })).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('region', { name: /助手草稿/ })).toBeNull();
  }, 15000);
});

describe('Idempotency-Key（前端）', () => {
  it('api() 能带自定义头，但改不掉 accept / CSRF；建助手、立即运行都带键', async () => {
    await api('POST', '/api/x', {}, fetch, { 'idempotency-key': 'k1', 'x-aroomo-request': '0' }).catch(() => undefined);
    const h = calls.at(-1)!.headers;
    expect(h['idempotency-key']).toBe('k1');
    expect(h['x-aroomo-request']).toBe('1');
    expect(h.accept).toBe('application/json');
    await assistantsApi.create(inputFromDraft(DATA), 'draft_k2').catch(() => undefined);
    expect(calls.at(-1)!.headers['idempotency-key']).toBe('draft_k2');
    await assistantsApi.runNow('a1', 'run-k3').catch(() => undefined);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/assistants/a1/runs' });
    expect(calls.at(-1)!.headers['idempotency-key']).toBe('run-k3');
    await assistantsApi.runNow('a1').catch(() => undefined);
    expect(calls.at(-1)!.headers['idempotency-key']).toBeUndefined();
  });
});
