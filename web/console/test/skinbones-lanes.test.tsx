/**
 * Skin/Bones 切片 3（开关 SKIN_BONES 打开，mock）：/console 驾驶舱下面的角色泳道。
 * 四职能角色（Architect / Scraper / Summarizer / Monitor）各自一道，对不上的归「其他」；空道有一句话；
 * 读屏能听出是几道、每道几个人；键盘能走到成员按钮并打开详情；家人账号看不到。
 * 关着的情况（没有泳道）见 skinbones-off.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/skinbones-flag', () => ({ SKIN_BONES: true }));
vi.mock('@/lib/work-flag', () => ({ WORK: false }));
vi.mock('@/lib/flags', () => ({ TASK_CARDS: false, QUICK_REPLIES: false, CONV_FILTER: false, SCHEDULE_PAGE: false, ASSISTANT_DRAFT: false, ASSISTANTS: false, SAVED_CHATS: false, SKELETON_SHIMMER: false }));

const { ChatPage } = await import('@/chat/ChatPage');
const { LANES, laneOf } = await import('@/chat/RoleLanes');

const member = (id: string, name: string, role: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  aliases: [],
  capabilityTags: [],
  enabled: true,
  pinned: false,
  status: 'active',
  leadEligible: false,
  role,
  ...extra,
});
const MEMBERS = [
  member('m1', '小建', 'Architect'),
  member('m2', '小爬', 'scraper'),
  member('m3', '小结', '总结'),
  member('m4', '小看', 'Monitor', { activity: { state: 'working' } }),
  member('m5', '小杂', '打杂'),
  member('m6', '小空', null),
];

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
let membersStatus = 200;
beforeEach(() => {
  membersStatus = 200;
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return membersStatus === 200 ? json({ members: MEMBERS }) : new Response('{}', { status: membersStatus });
      if (url.startsWith('/api/inbox/unread-count')) return json({ total: 0 });
      if (url.startsWith('/api/capabilities')) return json({ items: [] });
      if (url.startsWith('/api/audit')) return json({ entries: [] });
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

const open = (path = '/console') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>,
  );
/** 一道：用它的读屏名字找（「架构（Architect），1 位成员」） */
const lane = async (name: string | RegExp) => screen.findByRole('region', { name });

describe('角色映射（纯函数）', () => {
  it('四职能角色认英文名、中文名，大小写不论', () => {
    expect(laneOf('Architect')).toBe('architect');
    expect(laneOf('scraper')).toBe('scraper');
    expect(laneOf('总结')).toBe('summarizer');
    expect(laneOf('  MONITOR ')).toBe('monitor');
  });
  it('对不上的、空的都归「其他」，不报错', () => {
    expect(laneOf('打杂')).toBe('other');
    expect(laneOf(null)).toBe('other');
    expect(laneOf(undefined)).toBe('other');
    expect(laneOf('')).toBe('other');
  });
  it('四职能角色就是规范里那四个', () => {
    expect(LANES.map((l) => l.en)).toEqual(['Architect', 'Scraper', 'Summarizer', 'Monitor']);
  });
});

describe('/console 角色泳道', () => {
  it('四职能角色各一道，再加一道「其他」，每道报人数', async () => {
    open();
    expect(await screen.findByRole('heading', { name: '角色泳道' })).toBeInTheDocument();
    for (const n of ['架构（Architect），1 位成员', '采集（Scraper），1 位成员', '总结（Summarizer），1 位成员', '监控（Monitor），1 位成员', '其他，2 位成员']) {
      expect(await lane(n)).toBeInTheDocument();
    }
  });
  it('成员按 role 进对应的道，对不上的和没有 role 的进「其他」', async () => {
    open();
    expect(within(await lane(/^架构/)).getByRole('button', { name: /小建/ })).toBeInTheDocument();
    expect(within(await lane(/^采集/)).getByRole('button', { name: /小爬/ })).toBeInTheDocument();
    expect(within(await lane(/^总结/)).getByRole('button', { name: /小结/ })).toBeInTheDocument();
    const other = within(await lane(/^其他/));
    expect(other.getByRole('button', { name: /小杂/ })).toBeInTheDocument();
    expect(other.getByRole('button', { name: /小空/ })).toBeInTheDocument();
  });
  it('每个成员的读屏名字带上此刻状态（不编数字）', async () => {
    open();
    // 有 activity 的用 activity 的字，没有的按在职/停用
    expect(within(await lane(/^监控/)).getByRole('button', { name: '小看，工作中，打开成员详情' })).toBeInTheDocument();
    expect(within(await lane(/^架构/)).getByRole('button', { name: '小建，在职，打开成员详情' })).toBeInTheDocument();
  });
  it('点成员打开他的详情页（地址到 /team?member=…）', async () => {
    open();
    fireEvent.click(within(await lane(/^架构/)).getByRole('button', { name: /小建/ }));
    expect(await screen.findByRole('heading', { name: '小建' })).toBeInTheDocument();
  });
  it('成员按钮是真按钮，键盘走得到（不是只能点的 div）', async () => {
    open();
    const btn = within(await lane(/^架构/)).getByRole('button', { name: /小建/ });
    expect(btn.tagName).toBe('BUTTON');
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });
  it('空道有一句话，不留白', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/members') return json({ members: [] });
        if (url.startsWith('/api/inbox/unread-count')) return json({ total: 0 });
        if (url.startsWith('/api/capabilities')) return json({ items: [] });
        if (url.startsWith('/api/audit')) return json({ entries: [] });
        return new Response('{}', { status: 404 });
      }),
    );
    open();
    expect(await lane('架构（Architect），0 位成员')).toBeInTheDocument();
    expect((await screen.findAllByText('这一道还没有成员。')).length).toBe(5);
  });
  it('成员没读到：说一句 + 「重试」，不编一个空泳道', async () => {
    membersStatus = 500;
    open();
    expect(await screen.findByText('成员没读到。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^架构/ })).toBeNull();
  });
  it('家人账号的驾驶舱里没有泳道', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '', role: 'user' }));
    open();
    expect(await screen.findByText('概览')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '角色泳道' })).toBeNull();
  });
});
