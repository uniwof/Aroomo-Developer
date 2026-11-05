/**
 * 阶段 2 开关后面的组件（X-03 X-11 X-15 X-02 X-22 X-27）：用固定数据直接渲染，不经对话页。
 * 另验开关默认全关、对话页里没有这些入口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FLAGS } from '@/lib/flags';
import { QuickReplies } from '@/chat/thread/cards/QuickReplies';
import { TaskCard, progressText, type TaskStep } from '@/chat/thread/cards/TaskCard';
import { AssistantDraftCard, type AssistantDraft } from '@/chat/thread/cards/AssistantDraftCard';
import { SchedulePage, lastText, type ScheduleRow } from '@/chat/pages/assistants/schedule';
import { PRESETS, scheduleText, splitInstructions, whenText, zoneText } from '@/chat/pages/assistants/schedule-text';
import { ConvFilter, RunningTag, applyConvFilter } from '@/chat/conv-filter';

afterEach(cleanup);

describe('开关', () => {
  it('integrate/stage2：Core 助手接口、会话存库已并入，除快速回复（Core 还没有反问数据块）外全部打开', () => {
    expect(FLAGS).toEqual({ taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false });
  });
});

describe('X-11 快速回复', () => {
  it('最多 3 个现成答案 + 固定「我自己写…」；点了立刻发出原话，之后只留一行「已回复」', () => {
    const send = vi.fn();
    const write = vi.fn();
    render(<QuickReplies options={['可以', '可以', '不用', '晚点再说', '第四个']} onSend={send} onWrite={write} />);
    const g = screen.getByRole('group', { name: '快速回复' });
    expect(within(g).getAllByRole('button').map((b) => b.textContent)).toEqual(['可以', '不用', '晚点再说', '我自己写…']);
    fireEvent.click(within(g).getByRole('button', { name: '快速回复：可以' }));
    expect(send).toHaveBeenCalledWith('可以');
    expect(screen.queryByRole('group', { name: '快速回复' })).toBeNull();
    expect(screen.getByText('已回复：可以')).toBeInTheDocument();
  });
  it('「我自己写…」交给调用方打开输入框，不发东西', () => {
    const send = vi.fn();
    const write = vi.fn();
    render(<QuickReplies options={['好']} onSend={send} onWrite={write} />);
    fireEvent.click(screen.getByRole('button', { name: '我自己写…' }));
    expect(write).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

const steps: TaskStep[] = [
  { id: '1', who: '小B', what: '搜索', status: 'done' },
  { id: '2', who: '小C', what: '筛选', status: 'running' },
  { id: '3', who: '组长', what: '汇总', status: 'waiting' },
];

describe('X-03 任务卡', () => {
  it('标题 + 一句进度 + 步骤一行一个「谁 · 做什么 · 状态」（静态文字）', () => {
    render(<TaskCard title="资源周报 · 第 12 次" steps={steps} />);
    const card = screen.getByRole('region', { name: '资源周报 · 第 12 次' });
    expect(within(card).getByText('3 步，完成 1 步')).toBeInTheDocument();
    const items = within(within(card).getByRole('list', { name: '步骤' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['小B · 搜索完成', '小C · 筛选进行中', '组长 · 汇总等待']);
    expect(card.querySelector('[class*="spin"], [class*="animate"]')).toBeNull();
  });
  it('确认块：想做什么、为什么、花多少，「拒绝 / 同意」；处理过只剩静态结果', () => {
    const approve = vi.fn();
    const reject = vi.fn();
    const c = { what: '调用付费模型写摘要', why: '免费模型额度用完了', cost: '约 0.2 元', onApprove: approve, onReject: reject };
    const { rerender } = render(<TaskCard title="t" steps={[{ id: '1', who: '小B', what: '写摘要', status: 'confirm' }]} confirm={{ ...c, state: 'open' }} />);
    expect(progressText([{ id: '1', who: '小B', what: '写摘要', status: 'confirm' }])).toMatch(/^有一步等你确认/);
    const block = screen.getByRole('group', { name: '等你确认' });
    expect(within(block).getByText('为什么：免费模型额度用完了')).toBeInTheDocument();
    expect(within(block).getByText('花多少：约 0.2 元')).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: '同意' }));
    fireEvent.click(within(block).getByRole('button', { name: '拒绝' }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
    rerender(<TaskCard title="t" steps={[]} confirm={{ ...c, state: 'approved' }} />);
    expect(screen.queryByRole('button', { name: '同意' })).toBeNull();
    expect(screen.getByText('已同意')).toBeInTheDocument();
  });
  it('反问块：有现成答案就给快速回复；点「我自己写…」换成输入框并聚焦，回车发出', () => {
    const reply = vi.fn();
    render(<TaskCard title="t" steps={[]} question={{ who: '小C', text: '只要中文资源吗？', replies: ['只要中文', '都要'], onReply: reply }} />);
    const block = screen.getByRole('group', { name: '小C 问你' });
    fireEvent.click(within(block).getByRole('button', { name: '我自己写…' }));
    const input = within(block).getByLabelText('回答 小C');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '中文和英文都要' } });
    fireEvent.click(within(block).getByRole('button', { name: '发送' }));
    expect(reply).toHaveBeenCalledWith('中文和英文都要');
    expect(within(block).getByText('已回复：中文和英文都要')).toBeInTheDocument();
  });
});

const draft: AssistantDraft = {
  name: '资源周报',
  instructions: '每周找全网新的免费模型，筛好了告诉我。',
  lead: '小A',
  members: ['小A', '小B'],
  scheduleKind: 'weekly',
  scheduleSpec: { time: '09:00', days: [1] },
  timezone: 'Asia/Shanghai',
  nextRunAt: '2026-11-09T01:00:00Z',
  budget: 'low',
};

describe('X-15 助手草稿卡', () => {
  it('写清名字、任务、组长和成员、计划、下次运行、额度档；只有点「建好」才建', async () => {
    const create = vi.fn(async () => undefined);
    render(<AssistantDraftCard draft={draft} onCreate={create} onEdit={vi.fn()} onDismiss={vi.fn()} />);
    const card = screen.getByRole('region', { name: '助手草稿：资源周报' });
    expect(within(card).getByText('小A')).toBeInTheDocument();
    expect(within(card).getByText('小B')).toBeInTheDocument();
    expect(within(card).getByText(/每周一 09:00/)).toBeInTheDocument();
    expect(within(card).getByText('11-09 周一 09:00')).toBeInTheDocument();
    expect(within(card).getByText('低（只用免费模型）')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: '建好' }));
    expect(await within(card).findByText('已建好「资源周报」')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('没建成：一行原因，按钮还在可以再点；「不用了」不建', async () => {
    const create = vi.fn(async () => {
      throw new Error('名字重复了');
    });
    const dismiss = vi.fn();
    render(<AssistantDraftCard draft={draft} onCreate={create} onEdit={vi.fn()} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '建好' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('名字重复了');
    fireEvent.click(screen.getByRole('button', { name: '不用了' }));
    expect(dismiss).toHaveBeenCalled();
    expect(screen.getByText('不用了，没有建')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('X-02 计划的人话和定时列表', () => {
  it('人话：预设四种、星期、工作日、间隔；数据不对写「计划没设好」', () => {
    expect(PRESETS.map((p) => scheduleText(p.kind, p.spec))).toEqual(['每天 09:00', '每个工作日 09:00', '每周一 09:00', '每 6 小时']);
    expect(scheduleText('weekly', { time: '08:30', days: [3, 1] })).toBe('每周一、三 08:30');
    expect(scheduleText('manual')).toBe('只在我叫它时');
    expect(scheduleText('daily', {})).toBe('计划没设好');
    expect(scheduleText('interval', { everyHours: 0 })).toBe('计划没设好');
    expect(zoneText('Asia/Shanghai', 'Asia/Shanghai')).toBe('本机时区');
    expect(zoneText('America/New_York', 'Asia/Shanghai')).toBe('America/New_York');
    expect(whenText(null)).toBe('—');
    expect(splitInstructions('找免费模型。只看中文，筛掉要绑卡的。')).toEqual({ goal: '找免费模型。', rest: '只看中文，筛掉要绑卡的。' });
  });

  const rows: ScheduleRow[] = [
    { id: 'a1', name: '资源周报', members: ['小A', '小B', '小C', '小D'], instructions: '找免费模型。只看中文。', scheduleKind: 'weekly', scheduleSpec: { time: '09:00', days: [1] }, timezone: 'Asia/Shanghai', nextRunAt: '2026-11-09T01:00:00Z', lastRun: { status: 'succeeded', summary: '找到 12 条' }, enabled: true },
    { id: 'a2', name: '签到', members: ['小B'], instructions: '每天签到。', scheduleKind: 'daily', scheduleSpec: { time: '08:00' }, timezone: 'Asia/Shanghai', nextRunAt: null, lastRun: { status: 'failed', summary: '小B 的 Key 无效' }, enabled: false },
  ];

  it('一张表：每列都有、头像叠放最多 3 个 +N、暂停的写「已暂停」、失败加粗；启用开关只在给了接口时出现', () => {
    const toggle = vi.fn();
    const { rerender } = render(<SchedulePage rows={rows} onToggle={toggle} />);
    const t = screen.getByRole('table', { name: '全部计划' });
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['成员', '助手', '目标', '指令摘要', '什么时候跑', '时区', '下次运行', '上次结果', '启用']);
    expect(within(t).getByLabelText('成员：小A、小B、小C、小D')).toHaveTextContent('+1');
    expect(within(t).getByText('完成：找到 12 条')).toBeInTheDocument();
    expect(within(t).getByText('已暂停')).toBeInTheDocument();
    expect(within(t).getByText('失败：小B 的 Key 无效')).toHaveClass('sched-strong');
    fireEvent.click(within(t).getByRole('switch', { name: '启用「签到」' }));
    expect(toggle).toHaveBeenCalledWith('a2', true);
    rerender(<SchedulePage rows={rows} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '启用' })).toBeNull();
  });
  it('加载、出错、空：各一句话', () => {
    const { rerender } = render(<SchedulePage rows={null} />);
    expect(screen.getByText('正在加载…')).toBeInTheDocument();
    rerender(<SchedulePage rows={null} error="助手列表暂时打不开" />);
    expect(screen.getByRole('alert')).toHaveTextContent('助手列表暂时打不开');
    rerender(<SchedulePage rows={[]} />);
    expect(screen.getByText('还没有定时的助手。')).toBeInTheDocument();
    expect(lastText(null)).toBe('还没跑过');
  });
});

describe('X-27 / X-22 会话筛选', () => {
  const list = [
    { id: 'a', unread: true },
    { id: 'b', running: true },
    { id: 'c' },
    { id: 'd', unread: true, running: true },
  ];
  it('全部：进行中的排最前，其余保持原顺序；未读 / 进行中只留对应的', () => {
    expect(applyConvFilter(list, 'all').map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(applyConvFilter(list, 'unread').map((r) => r.id)).toEqual(['d', 'a']);
    expect(applyConvFilter(list, 'running').map((r) => r.id)).toEqual(['b', 'd']);
  });
  it('三个胶囊是单选筛选（不是标签页），「进行中」是静态文字小标', async () => {
    const change = vi.fn();
    render(
      <>
        <ConvFilter value="all" onChange={change} />
        <RunningTag />
      </>,
    );
    const g = screen.getByRole('radiogroup', { name: '筛选对话' });
    expect(within(g).getAllByRole('radio').map((r) => r.textContent)).toEqual(['全部', '未读', '进行中']);
    expect(within(g).getByRole('radio', { name: '全部' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(within(g).getByRole('radio', { name: '未读' }));
    await waitFor(() => expect(change).toHaveBeenCalledWith('unread'));
    expect(screen.getAllByText('进行中').length).toBe(2);
  });
});
