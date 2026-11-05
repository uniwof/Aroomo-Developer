/**
 * 助手界面接 Core /api/assistants（#250 integrate/stage2）：会话栏「助手」列表、新建助手 → 预览草稿卡 → 建好、
 * 助手详情（固定会话、立即运行、暂停 / 继续、运行步骤任务卡）、全部计划的启用开关、家人账号不请求。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { draftFromPart, stepsToTask, toInput, toRow } from '@/chat/pages/assistants/AssistantPages';
import type { Assistant, AssistantRun } from '@/lib/assistants';
import type { Member } from '@/lib/api';

const M = (id: string, name: string): Member => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }) as unknown as Member;
const members = [M('m-a', '小A'), M('m-b', '小B')];

const run = (over: Partial<AssistantRun> = {}): AssistantRun => ({
  id: 'r1',
  assistantId: 'a1',
  trigger: 'manual',
  scheduledFor: null,
  requestedAt: '2026-11-05T06:00:00.000Z',
  startedAt: '2026-11-05T06:00:01.000Z',
  finishedAt: '2026-11-05T06:00:31.000Z',
  durationMs: 30000,
  status: 'succeeded',
  failureCode: null,
  summary: '找到 3 条',
  usageState: 'ample',
  messageIds: [],
  ...over,
});

const asst = (over: Partial<Assistant> = {}): Assistant => ({
  id: 'a1',
  name: '资源周报',
  instructions: '每周找全网新的免费模型。筛好了告诉我。',
  leadMemberId: 'm-a',
  members: [
    { memberId: 'm-a', role: 'lead', position: 0 },
    { memberId: 'm-b', role: 'worker', position: 1 },
  ],
  enabled: true,
  schedule: { kind: 'weekly', time: '09:00', days: [1], text: '每周一 09:00' },
  timezone: 'Asia/Shanghai',
  budgetLevel: 'low',
  notify: true,
  conversationId: 'c1',
  nextRunAt: '2026-11-09T01:00:00.000Z',
  pausedAt: null,
  createdAt: '2026-11-05T05:00:00.000Z',
  updatedAt: '2026-11-05T05:00:00.000Z',
  status: 'normal',
  unread: true,
  lastRun: run(),
  activeRunId: null,
  ...over,
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

let state: { list: Assistant[]; calls: Array<{ method: string; url: string; body?: unknown }> };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  state = { list: [asst(), asst({ id: 'a2', name: '签到', unread: false, status: 'running', schedule: { kind: 'daily', time: '08:00', text: '每天 08:00' }, lastRun: null, activeRunId: 'r9' })], calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method, url, body });
      if (url === '/api/members') return json({ members });
      if (url === '/api/assistants' && method === 'GET') return json({ assistants: state.list });
      if (url === '/api/assistants/preview')
        return json({
          scheduleText: '每周一 09:00',
          nextRunAt: '2026-11-09T01:00:00.000Z',
          nextRunText: '下次运行：11-09 周一 09:00',
          part: { type: 'data-aroomo-assistant-draft', data: { ...body, schedule: body.schedule, scheduleText: '每周一 09:00', nextRunAt: '2026-11-09T01:00:00.000Z' } },
        });
      if (url === '/api/assistants' && method === 'POST') {
        const a = asst({ id: 'a3', name: body.name, unread: false, lastRun: null });
        state.list = [...state.list, a];
        return json({ assistant: a, created: true }, 201);
      }
      const m = /^\/api\/assistants\/([^/?]+)(.*)$/.exec(url);
      if (m) {
        const a = state.list.find((x) => x.id === m[1]);
        if (!a) return json({ error: { code: 'NOT_FOUND', message: '找不到这个助手' } }, 404);
        const rest = m[2]!;
        if (rest === '') return json({ assistant: a });
        if (rest.startsWith('/runs?')) return json({ runs: a.lastRun ? [a.lastRun] : [], nextBefore: null });
        if (rest === '/runs' && method === 'POST') {
          const r = run({ id: 'r2', status: 'running', finishedAt: null, durationMs: null, summary: null });
          a.lastRun = r;
          a.status = 'running';
          return json({ run: r, created: true }, 202);
        }
        if (/^\/runs\/[^/]+$/.test(rest))
          return json({ run: { ...run(), steps: [{ stepNo: 0, memberId: 'm-a', action: 'plan', status: 'done', detail: '', startedAt: '', updatedAt: '' }, { stepNo: 1, memberId: 'm-b', action: 'work', status: 'running', detail: '去查 A 站', startedAt: '', updatedAt: '' }] } });
        if (rest.startsWith('/messages')) return json({ messages: [{ id: 'msg1', seq: 1, role: 'member', memberId: 'm-a', runId: 'r1', content: '汇总完成：找到 3 条', createdAt: '2026-11-05T06:00:31.000Z' }] });
        if (rest === '/read') return new Response(null, { status: 204 });
        if (rest === '/pause') {
          a.pausedAt = '2026-11-05T07:00:00.000Z';
          a.status = 'paused';
          return json({ assistant: a });
        }
        if (rest === '/resume') {
          a.pausedAt = null;
          a.status = 'normal';
          return json({ assistant: a });
        }
      }
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

async function openStaff() {
  renderPage();
  fireEvent.click(screen.getByRole('radio', { name: '助手' }));
  return screen.findByRole('button', { name: /^助手 资源周报/ });
}

describe('数据换算', () => {
  it('新建表单 → Core 请求体：组长默认第一位、计划用预设（everyHours）、带本机时区', () => {
    const b = toInput({ name: ' 周报 ', instructions: '每周找免费模型告诉我', members: ['m-b', 'm-a'], lead: '', scheduleId: 'every-6h', budget: 'mid' });
    expect(b).toMatchObject({ name: '周报', members: ['m-b', 'm-a'], leadMemberId: 'm-b', schedule: { kind: 'interval', everyHours: 6 }, budgetLevel: 'mid' });
    expect(typeof b.timezone).toBe('string');
  });
  it('草稿数据块、计划行、运行步骤：成员 id 换成名字；步骤状态换成任务卡的状态', () => {
    const d = draftFromPart({ type: 'data-aroomo-assistant-draft', data: { name: 'x', instructions: 'y', members: ['m-a', 'm-b'], leadMemberId: 'm-b', schedule: { kind: 'weekly', time: '09:00', days: [1] }, timezone: 'Asia/Shanghai', budgetLevel: 'low', nextRunAt: null, scheduleText: '' } }, members);
    expect(d).toMatchObject({ lead: '小B', members: ['小A', '小B'], scheduleKind: 'weekly', scheduleSpec: { time: '09:00', days: [1] }, budget: 'low' });
    expect(toRow(asst({ pausedAt: '2026-11-05T07:00:00.000Z' }), members)).toMatchObject({ members: ['小A', '小B'], enabled: false, lastRun: { status: 'succeeded', summary: '找到 3 条' } });
    expect(
      stepsToTask(
        [
          { stepNo: 0, memberId: 'm-a', action: 'plan', status: 'done', detail: '', startedAt: '', updatedAt: '' },
          { stepNo: 1, memberId: null, action: 'confirm', status: 'waiting_confirmation', detail: '要调用付费模型：PaidBot', startedAt: '', updatedAt: '' },
        ],
        members,
      ),
    ).toEqual([
      { id: '0', who: '小A', what: '分工', status: 'done' },
      { id: '1', who: '系统', what: '付费确认：要调用付费模型：PaidBot', status: 'confirm' },
    ]);
  });
});

describe('会话栏「助手」', () => {
  it('列表来自 GET /api/assistants：进行中的排最前、有静态「进行中」小标；未读写进读屏名称；筛选「未读」只留有新结果的', async () => {
    await openStaff();
    const list = screen.getByRole('list', { name: '助手列表' });
    const rows = within(list).getAllByRole('button');
    expect(rows[0]).toHaveAccessibleName(/^助手 签到，2 位成员，进行中/);
    expect(within(rows[0]!).getByText('进行中')).toBeInTheDocument();
    expect(rows[1]).toHaveAccessibleName(/^助手 资源周报，2 位成员，有新结果，找到 3 条/);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '筛选助手' })).getByRole('radio', { name: '未读' }));
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('家人账号：不请求 /api/assistants，不显示「助手」分段，没有新建助手、全部计划', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '小明', role: 'user' }));
    renderPage();
    // #273（审计 C11）：家人账号的会话栏不放「对话 / 助手」切换
    expect(screen.queryByRole('radio', { name: '助手' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建助手' })).toBeNull();
    expect(screen.queryByRole('button', { name: '看全部计划' })).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(state.calls.some((c) => c.url.startsWith('/api/assistants'))).toBe(false);
  });
});

describe('新建助手（7.11 + X-15 草稿卡）', () => {
  it('填表 →「预览」调 /preview → 草稿卡；「改一改」回到表单不丢内容；只有「建好」才 POST，建好后打开详情', async () => {
    await openStaff();
    fireEvent.click(screen.getByRole('button', { name: '新建助手' }));
    const dlg = await screen.findByRole('dialog', { name: '新建助手' });
    fireEvent.click(within(dlg).getByRole('button', { name: '预览' }));
    expect(within(dlg).getByRole('alert')).toHaveTextContent('请给助手起个名字');
    fireEvent.change(within(dlg).getByLabelText('名字（必填）'), { target: { value: '资源周报二' } });
    fireEvent.change(within(dlg).getByLabelText('任务说明（必填）'), { target: { value: '每周找全网新的免费模型，筛好了告诉我' } });
    fireEvent.click(await within(dlg).findByRole('checkbox', { name: '小A' }));
    fireEvent.click(within(dlg).getByRole('checkbox', { name: '小B' }));
    fireEvent.click(within(dlg).getByRole('radio', { name: '小B' }));
    fireEvent.click(within(dlg).getByRole('radio', { name: '每周一 09:00' }));
    fireEvent.click(within(dlg).getByRole('button', { name: '预览' }));
    const card = await within(dlg).findByRole('region', { name: '助手草稿：资源周报二' });
    const pv = state.calls.find((c) => c.url === '/api/assistants/preview')!;
    expect(pv.body).toMatchObject({ members: ['m-a', 'm-b'], leadMemberId: 'm-b', schedule: { kind: 'weekly', time: '09:00', days: [1] }, budgetLevel: 'low' });
    expect(state.calls.some((c) => c.url === '/api/assistants' && c.method === 'POST')).toBe(false);
    fireEvent.click(within(card).getByRole('button', { name: '改一改' }));
    expect(within(dlg).getByLabelText('名字（必填）')).toHaveValue('资源周报二');
    fireEvent.click(within(dlg).getByRole('button', { name: '预览' }));
    fireEvent.click(within(await within(dlg).findByRole('region', { name: '助手草稿：资源周报二' })).getByRole('button', { name: '建好' }));
    await waitFor(() => expect(state.calls.filter((c) => c.url === '/api/assistants' && c.method === 'POST')).toHaveLength(1));
    expect(await screen.findByRole('button', { name: '立即运行' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '新建助手' })).toBeNull();
  });
});

describe('助手详情', () => {
  it('固定会话的消息、运行记录；立即运行 POST …/runs 后按钮变「正在运行…」；暂停 / 继续调对应接口', async () => {
    fireEvent.click(await openStaff());
    expect(await screen.findByText('汇总完成：找到 3 条')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '资源周报 的对话' })).toBeInTheDocument();
    await waitFor(() => expect(state.calls.some((c) => c.url === '/api/assistants/a1/read' && c.method === 'POST')).toBe(true));
    const hist = screen.getByRole('region', { name: '运行记录' });
    fireEvent.click(within(hist).getByRole('button', { name: /手动 · 完成/ }));
    expect(await within(hist).findByText('小B · 做事：去查 A 站')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(await screen.findByText('已暂停，不会按计划运行')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('已继续，会按计划运行')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即运行' }));
    expect(await screen.findByRole('button', { name: '正在运行…' })).toBeDisabled();
    expect(state.calls.filter((c) => c.url === '/api/assistants/a1/runs' && c.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('region', { name: '这次运行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消这次运行' })).toBeInTheDocument();
  });
});

describe('X-02 全部计划', () => {
  it('从助手分段打开整页表；启用开关调 pause；点名字打开详情', async () => {
    await openStaff();
    fireEvent.click(screen.getByRole('button', { name: '看全部计划' }));
    const t = await screen.findByRole('table', { name: '全部计划' });
    fireEvent.click(within(t).getByRole('switch', { name: '启用「资源周报」' }));
    await waitFor(() => expect(state.calls.some((c) => c.url === '/api/assistants/a1/pause')).toBe(true));
    fireEvent.click(within(t).getByRole('button', { name: '资源周报' }));
    expect(await screen.findByRole('button', { name: '立即运行' })).toBeInTheDocument();
  });
});
