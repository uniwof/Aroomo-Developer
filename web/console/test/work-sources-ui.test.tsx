/**
 * /work 切片 2 界面：公共记忆版本、助手成功运行作为版本来源（docs/api/design-work-v1.md「数据从哪来」）。
 * - 添加项目可选本账号的公共记忆主题、助手（只列 Core 给的真实列表，读不到就只留 GitHub 一栏）；
 * - 时间线写出三种来源；版本详情：公共记忆显示那一版正文（被清理了说一句），助手显示这次运行的完整结果 + 打开那个助手；
 * - 不是 GitHub 的版本不显示「产物」「打开 GitHub」，也不显示审核按钮（审核是另一片）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkPage } from '@/chat/pages/work/WorkPage';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AID = '00000000-0000-4000-8000-0000000000a1';
const P = {
  id: 'p1',
  name: '占位项目',
  status: 'active',
  sources: [{ type: 'github', repo: 'octo/alpha' }, { type: 'memory', topic: 'family-plan' }, { type: 'assistant', assistantId: AID }],
  lastSyncAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
};
const MEM = { id: 'vm', projectId: 'p1', label: '第 2 版', title: '占位主题', actor: null, artifacts: [], sourceType: 'memory', sourceState: 'none', sourceAt: '2026-11-02T00:00:00.000Z', syncedAt: '2026-11-03T00:00:00.000Z' };
const RUN = {
  ...MEM,
  id: 'vr',
  label: '占位助手',
  title: '占位结果第一行',
  actor: { type: 'assistant', name: '占位助手', id: AID },
  sourceType: 'assistant_run',
};

let calls: Array<{ method: string; url: string; body?: unknown }>;
let handler: (method: string, url: string, body: unknown) => Response | Promise<Response>;
beforeEach(() => {
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      return handler(method, url, body);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('/work 添加项目：公共记忆、助手来源', () => {
  it('可选本账号的公共记忆主题和助手，POST 带上三种来源', async () => {
    handler = (method, url) => {
      if (url === '/api/memory') return json(200, { topics: [{ topic: 'family-plan', title: '占位主题', version: 2, updatedAt: '2026-11-02T00:00:00.000Z' }] });
      if (url === '/api/assistants') return json(200, { assistants: [{ id: AID, name: '占位助手' }] });
      if (method === 'POST') return json(201, { project: P });
      return json(200, { projects: [] });
    };
    render(<WorkPage onGo={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    fireEvent.change(screen.getByLabelText('项目名字（必填）'), { target: { value: '占位项目' } });
    fireEvent.change(screen.getByLabelText(/GitHub 公开仓库/), { target: { value: 'octo/alpha' } });
    const mem = await screen.findByLabelText(/公共记忆主题/);
    await waitFor(() => expect(within(mem).getByRole('option', { name: '占位主题（family-plan）' })).toBeInTheDocument());
    fireEvent.change(mem, { target: { value: 'family-plan' } });
    const asst = screen.getByLabelText(/助手/);
    await waitFor(() => expect(within(asst).getByRole('option', { name: '占位助手' })).toBeInTheDocument());
    fireEvent.change(asst, { target: { value: AID } });
    fireEvent.click(screen.getByRole('button', { name: '建好' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: '占位项目', sources: P.sources });
  });

  it('列表读不到：只留 GitHub 一栏，照样能建', async () => {
    handler = (method, url) => {
      if (url === '/api/memory' || url === '/api/assistants') return json(503, { error: { code: 'X', message: '不可用' } });
      if (method === 'POST') return json(201, { project: { ...P, sources: [] } });
      return json(200, { projects: [] });
    };
    render(<WorkPage onGo={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/memory' || c.url === '/api/assistants')).toHaveLength(2));
    expect(screen.queryByLabelText(/公共记忆主题/)).toBeNull();
    fireEvent.change(screen.getByLabelText('项目名字（必填）'), { target: { value: '占位项目' } });
    fireEvent.click(screen.getByRole('button', { name: '建好' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: '占位项目' }));
  });
});

describe('/work 时间线：三种来源', () => {
  it('副标题写出 GitHub 仓库、公共记忆主题、助手个数；公共记忆、助手版本不写产物数', async () => {
    handler = (_m, url) => (url === '/api/work/projects/p1' ? json(200, { project: P }) : json(200, { versions: [RUN, MEM], nextCursor: null }));
    render(<WorkPage project="p1" onGo={() => undefined} />);
    expect(await screen.findByText(/来源：GitHub octo\/alpha、公共记忆 family-plan、1 个助手/)).toBeInTheDocument();
    const items = within(await screen.findByRole('list', { name: '版本' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('占位助手');
    expect(items[0]).toHaveTextContent('占位结果第一行');
    expect(items[0]).not.toHaveTextContent('个产物');
    expect(items[1]).toHaveTextContent('第 2 版');
  });
});

describe('/work 版本详情：公共记忆、助手', () => {
  it('公共记忆：显示那一版正文；没有产物、没有「打开 GitHub」、没有审核按钮', async () => {
    handler = () => json(200, { version: MEM, open: { kind: 'memory', topic: 'family-plan', version: 2, body: '占位正文' } });
    render(<WorkPage project="p1" version="vm" onGo={() => undefined} />);
    expect(await screen.findByRole('heading', { name: /第 2 版/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '这一版的内容' })).toHaveTextContent('占位正文');
    expect(screen.queryByRole('list', { name: '产物' })).toBeNull();
    expect(screen.queryByText(/打开 GitHub/)).toBeNull();
    expect(screen.queryByText(/来源状态由 GitHub/)).toBeNull();
    expect(screen.queryByRole('button', { name: /通过|要修改|审核/ })).toBeNull();
  });

  it('公共记忆那一版被清理了：说一句，不编内容', async () => {
    handler = () => json(200, { version: MEM, open: { kind: 'memory', topic: 'family-plan', version: 2, body: null } });
    render(<WorkPage project="p1" version="vm" onGo={() => undefined} />);
    expect(await screen.findByText('这个版本已被清理。')).toBeInTheDocument();
  });

  it('助手：显示这次运行的完整结果；「打开助手」跳到那个助手；运行记录没了说一句', async () => {
    handler = () => json(200, { version: RUN, open: { kind: 'assistant', assistantId: AID, runId: 'r1', summary: '占位结果第一行\n第二行' } });
    const toAssistant = vi.fn();
    render(<WorkPage project="p1" version="vr" onGo={() => undefined} onAssistant={toAssistant} />);
    const region = await screen.findByRole('region', { name: '这次运行的结果' });
    expect(region).toHaveTextContent('第二行');
    expect(screen.getByText('占位助手', { selector: '.row-value' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开助手「占位助手」' }));
    expect(toAssistant).toHaveBeenCalledWith(AID);
    cleanup();
    handler = () => json(200, { version: RUN, open: { kind: 'assistant', assistantId: AID, runId: 'r1', summary: null } });
    render(<WorkPage project="p1" version="vr" onGo={() => undefined} onAssistant={toAssistant} />);
    expect(await screen.findByText('这次运行的记录已经删了。')).toBeInTheDocument();
  });
});
