/**
 * /work 切片 1 界面（docs/api/design-work-v1.md「/work 界面」）：项目列表、版本时间线、版本详情。
 * 只读真实接口（假 fetch，占位数据）；四态（加载/空/错带重试/有）；同步处理中锁住、结果读屏播报；
 * GitHub 来源只显示来源状态、不显示审核按钮；产物链接新标签打开，读屏名字带「离开 Aroomo」，链接不可用就说一句。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkPage } from '@/chat/pages/work/WorkPage';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const P1 = {
  id: 'p1',
  name: '占位项目甲',
  status: 'active',
  sources: [{ type: 'github', repo: 'octo/alpha' }],
  lastSyncAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  latest: { id: 'v1', label: 'v1.2.0', sourceState: 'prerelease', sourceAt: '2026-11-02T00:00:00.000Z' },
};
const P2 = { ...P1, id: 'p2', name: '占位项目乙', status: 'done', sources: [], latest: null };
const V1 = {
  id: 'v1',
  projectId: 'p1',
  label: 'v1.2.0',
  title: '第二个版本',
  actor: { type: 'github', name: 'octocat' },
  artifacts: [
    { type: 'page', title: 'Release 页面', url: 'https://github.com/octo/alpha/releases/tag/v1.2.0', size: null },
    { type: 'file', title: 'alpha.zip', url: 'https://github.com/octo/alpha/releases/download/v1.2.0/alpha.zip', size: 2048 },
    { type: 'file', title: 'odd.bin', url: null, size: 10 },
  ],
  sourceType: 'github_release',
  sourceState: 'prerelease',
  sourceAt: '2026-11-02T00:00:00.000Z',
  syncedAt: '2026-11-03T00:00:00.000Z',
};
const V0 = { ...V1, id: 'v0', label: 'v1.0.0', title: null, actor: null, artifacts: [], sourceType: 'github_tag', sourceState: 'tagged', sourceAt: null };

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

describe('/work 项目列表', () => {
  it('列出项目：名字、状态、最新版本 + 来源状态；点开进时间线；按状态筛', async () => {
    handler = () => json(200, { projects: [P1, P2] });
    const go = vi.fn();
    render(<WorkPage onGo={go} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载');
    const list = await screen.findByRole('list', { name: '项目' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('占位项目甲')).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('进行中');
    expect(items[0]).toHaveTextContent('v1.2.0');
    expect(items[0]).toHaveTextContent('预发布');
    expect(items[1]).toHaveTextContent('已完成');
    expect(items[1]).toHaveTextContent('还没有版本');
    fireEvent.click(within(items[0]!).getByRole('button', { name: /打开项目「占位项目甲」/ }));
    expect(go).toHaveBeenCalledWith({ project: 'p1' });

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'done' } });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('占位项目乙');
    expect(calls.every((c) => c.url === '/api/work/projects')).toBe(true);
  });

  it('空：一句话 + 添加项目（名字 + GitHub 仓库）→ POST 后出现在列表里', async () => {
    handler = (method, url) => {
      if (method === 'POST' && url === '/api/work/projects') return json(201, { project: { ...P1, latest: undefined } });
      return json(200, { projects: [] });
    };
    render(<WorkPage onGo={() => undefined} />);
    expect(await screen.findByText('还没有项目。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }));
    fireEvent.change(screen.getByLabelText('项目名字（必填）'), { target: { value: ' 占位项目甲 ' } });
    fireEvent.change(screen.getByLabelText(/GitHub 公开仓库/), { target: { value: 'octo/alpha' } });
    fireEvent.click(screen.getByRole('button', { name: '建好' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: '占位项目甲', sources: [{ type: 'github', repo: 'octo/alpha' }] });
    const list = await screen.findByRole('list', { name: '项目' });
    expect(list).toHaveTextContent('占位项目甲');
  });

  it('添加时 Core 拒绝（同名）：说出原因，表单留着', async () => {
    handler = (method) => (method === 'POST' ? err(409, 'NAME_TAKEN', '已经有同名的项目了') : json(200, { projects: [] }));
    render(<WorkPage onGo={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    fireEvent.change(screen.getByLabelText('项目名字（必填）'), { target: { value: '甲' } });
    fireEvent.click(screen.getByRole('button', { name: '建好' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已经有同名的项目了');
    expect(screen.getByLabelText('项目名字（必填）')).toHaveValue('甲');
  });

  it('读失败：一句话 + 重试，重试再读一次', async () => {
    let n = 0;
    handler = () => (n++ === 0 ? err(500, 'X', '服务暂时不可用') : json(200, { projects: [P1] }));
    render(<WorkPage onGo={() => undefined} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('项目没读到');
    fireEvent.click(within(alert).getByRole('button', { name: '重试，重新加载项目' }));
    expect(await screen.findByRole('list', { name: '项目' })).toHaveTextContent('占位项目甲');
  });
});

describe('/work/<项目> 版本时间线', () => {
  it('列版本（新在前）：标签、标题、产出者、来源状态、产物数；tag 没有产出者和时间就不编；点开进详情', async () => {
    handler = (_m, url) => {
      if (url === '/api/work/projects/p1') return json(200, { project: P1 });
      if (url === '/api/work/projects/p1/versions') return json(200, { versions: [V1, V0], nextCursor: null });
      return json(404, {});
    };
    const go = vi.fn();
    render(<WorkPage project="p1" onGo={go} />);
    expect(await screen.findByRole('heading', { name: '占位项目甲' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: '版本' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('v1.2.0');
    expect(items[0]).toHaveTextContent('第二个版本');
    expect(items[0]).toHaveTextContent('octocat');
    expect(items[0]).toHaveTextContent('预发布');
    expect(items[0]).toHaveTextContent('3 个产物');
    expect(items[1]).toHaveTextContent('已打标签');
    expect(items[1]).not.toHaveTextContent('octocat');
    // 不显示审核状态（GitHub 来源只读）
    expect(screen.queryByText(/草稿|审核中|要修改|已通过/)).toBeNull();
    fireEvent.click(within(items[0]!).getByRole('button', { name: /打开版本 v1\.2\.0/ }));
    expect(go).toHaveBeenCalledWith({ project: 'p1', version: 'v1' });
  });

  it('没有版本：一句话 + 同步；同步处理中锁住，结果读屏播报，再读一遍时间线', async () => {
    let synced = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = async (method, url) => {
      if (url === '/api/work/projects/p1') return json(200, { project: P1 });
      if (url === '/api/work/projects/p1/versions') return json(200, { versions: synced ? [V1] : [], nextCursor: null });
      if (method === 'POST' && url === '/api/work/projects/p1/sync') {
        await gate;
        synced = true;
        return json(200, { added: 1, unchanged: 0, failed: [{ source: 'octo/beta', reason: 'GitHub 限流，稍后再试' }] });
      }
      return json(404, {});
    };
    render(<WorkPage project="p1" onGo={() => undefined} />);
    expect(await screen.findByText(/还没有版本/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '同步' })[0]!);
    await waitFor(() => expect(screen.getByRole('button', { name: '正在同步…' })).toBeDisabled());
    release();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('新加 1 个版本'));
    expect(screen.getByRole('status')).toHaveTextContent('octo/beta：GitHub 限流，稍后再试');
    expect(await screen.findByRole('list', { name: '版本' })).toHaveTextContent('v1.2.0');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('同步太频繁（429）：说出 Core 给的原因', async () => {
    handler = (method, url) => {
      if (url === '/api/work/projects/p1') return json(200, { project: P1 });
      if (url === '/api/work/projects/p1/versions') return json(200, { versions: [V1], nextCursor: null });
      if (method === 'POST') return err(429, 'SYNC_TOO_SOON', '刚同步过，8 分钟后再试');
      return json(404, {});
    };
    render(<WorkPage project="p1" onGo={() => undefined} />);
    await screen.findByRole('list', { name: '版本' });
    fireEvent.click(screen.getByRole('button', { name: '同步' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('刚同步过，8 分钟后再试');
    expect(screen.getByRole('button', { name: '同步' })).toBeEnabled();
  });

  it('更早的版本用 nextCursor 翻页', async () => {
    handler = (_m, url) => {
      if (url === '/api/work/projects/p1') return json(200, { project: P1 });
      if (url === '/api/work/projects/p1/versions') return json(200, { versions: [V1], nextCursor: 'c1' });
      if (url === '/api/work/projects/p1/versions?cursor=c1') return json(200, { versions: [V0], nextCursor: null });
      return json(404, {});
    };
    render(<WorkPage project="p1" onGo={() => undefined} />);
    const list = await screen.findByRole('list', { name: '版本' });
    fireEvent.click(screen.getByRole('button', { name: '更早的版本' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: '更早的版本' })).toBeNull();
  });

  it('项目读不到（404）：说一句 + 回项目列表；别的失败给重试', async () => {
    handler = () => err(404, 'NOT_FOUND', '找不到这个项目');
    const go = vi.fn();
    render(<WorkPage project="nope" onGo={go} />);
    expect(await screen.findByText('找不到这个项目')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '回到项目列表' }));
    expect(go).toHaveBeenCalledWith({});
  });
});

describe('/work/<项目>?v=<版本> 版本详情', () => {
  it('产物：类型、标题、大小、「打开 GitHub ↗」新标签打开、读屏名字带「离开 Aroomo」；链接不可用说一句；不显示审核按钮', async () => {
    handler = (_m, url) => (url === '/api/work/versions/v1' ? json(200, { version: V1 }) : json(404, {}));
    render(<WorkPage project="p1" version="v1" onGo={() => undefined} />);
    expect(await screen.findByRole('heading', { name: /v1\.2\.0/ })).toBeInTheDocument();
    expect(screen.getByText('预发布')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: '产物' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent('alpha.zip');
    expect(items[1]).toHaveTextContent('2 KB');
    const link = within(items[1]!).getByRole('link', { name: /alpha\.zip.*离开 Aroomo/ });
    expect(link).toHaveAttribute('href', 'https://github.com/octo/alpha/releases/download/v1.2.0/alpha.zip');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('打开 GitHub ↗');
    expect(within(items[2]!).queryByRole('link')).toBeNull();
    expect(items[2]).toHaveTextContent('链接不可用');
    expect(screen.queryByRole('button', { name: /通过|要修改|审核/ })).toBeNull();
  });

  it('读失败：一句话 + 重试', async () => {
    let n = 0;
    handler = () => (n++ === 0 ? err(503, 'X', '服务暂时不可用') : json(200, { version: V0 }));
    render(<WorkPage project="p1" version="v0" onGo={() => undefined} />);
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: '重试，重新加载版本' }));
    expect(await screen.findByRole('heading', { name: /v1\.0\.0/ })).toBeInTheDocument();
    expect(screen.getByText('已打标签')).toBeInTheDocument();
    expect(screen.getByText('这个版本没有产物。')).toBeInTheDocument();
  });
});
