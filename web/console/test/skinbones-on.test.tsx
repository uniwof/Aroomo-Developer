/**
 * Skin/Bones 切片 1（开关 SKIN_BONES 打开，mock）：四区 /chat、/work、/assets、/console 各自有地址、各自渲染，
 * 224px 侧栏能在四区之间切换，键盘可达、当前区有 aria-current。关着的情况见 skinbones-off.test.tsx（真开关）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/skinbones-flag', () => ({ SKIN_BONES: true }));
vi.mock('@/lib/work-flag', () => ({ WORK: false }));
vi.mock('@/lib/flags', () => ({ TASK_CARDS: false, QUICK_REPLIES: false, CONV_FILTER: false, SCHEDULE_PAGE: false, ASSISTANT_DRAFT: false, ASSISTANTS: false, SAVED_CHATS: false, SKELETON_SHIMMER: false }));

const { ChatPage } = await import('@/chat/ChatPage');
const { OWNER_ONLY, pathOf, viewOf } = await import('@/chat/routes');

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      // 驾驶舱用到的现有接口：给空数据
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

const navBtn = async (name: string) => within(await screen.findByRole('navigation', { name: '工作台分区' })).getByRole('button', { name });
const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>,
  );

describe('Skin/Bones 四区地址', () => {
  it('/assets 来回换算一致，/work 空壳只认 /work 本身', () => {
    expect(viewOf('/assets', '')).toEqual({ kind: 'assets' });
    expect(pathOf({ kind: 'assets' })).toBe('/assets');
    expect(viewOf('/work', '')).toEqual({ kind: 'work' });
    expect(pathOf({ kind: 'work' })).toBe('/work');
    expect(viewOf('/console', '')).toEqual({ kind: 'console' });
    expect(viewOf('/chat', '')).toEqual({ kind: 'chat' });
  });
  it('资产区只给所有者', () => {
    expect(OWNER_ONLY).toContain('assets');
  });
});

describe('Skin/Bones 四区各自渲染', () => {
  it('/chat 还是对话', async () => {
    open('/chat');
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(await screen.findByRole('navigation', { name: '工作台分区' })).toBeInTheDocument();
  });
  it('/work 是一句话空状态 + 一个动作', async () => {
    open('/work');
    expect(await screen.findByText('这里会放项目和版本，还没有接上。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '先回到对话' })).toBeInTheDocument();
  });
  it('/assets 是一句话空状态 + 一个动作', async () => {
    open('/assets');
    expect(await screen.findByText('这里会放点子、工具与试用、知识库，还没有接上。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '先去资源库' })).toBeInTheDocument();
  });
  it('/console 还是驾驶舱', async () => {
    open('/console');
    expect(await screen.findByRole('heading', { name: '驾驶舱' })).toBeInTheDocument();
  });
});

describe('Skin/Bones 侧栏', () => {
  it('四区都在侧栏里，当前区标 aria-current', async () => {
    open('/chat');
    const nav = await screen.findByRole('navigation', { name: '工作台分区' });
    for (const label of ['对话', '工作', '资产', '控制台']) expect(within(nav).getByRole('button', { name: label })).toBeInTheDocument();
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toContain('对话');
  });
  it('点侧栏在四区之间切换，当前区跟着换', async () => {
    open('/chat');
    await screen.findByLabelText('输入消息');
    fireEvent.click(await navBtn('资产'));
    expect(await screen.findByText('这里会放点子、工具与试用、知识库，还没有接上。')).toBeInTheDocument();
    expect(await navBtn('资产')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(await navBtn('工作'));
    expect(await screen.findByText('这里会放项目和版本，还没有接上。')).toBeInTheDocument();
    fireEvent.click(await navBtn('对话'));
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
  });
  it('键盘能走到侧栏按钮上', async () => {
    open('/assets');
    const btn = await navBtn('控制台');
    btn.focus();
    expect(btn).toHaveFocus();
    // 原生 <button>：Enter 由浏览器转成 click（jsdom 不做这一步，这里核的是能聚焦、是按钮）
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn);
    expect(await screen.findByRole('heading', { name: '驾驶舱' })).toBeInTheDocument();
  });
});

describe('Skin/Bones 家人账号', () => {
  it('家人打开 /assets 落到对话，也看不到四区侧栏（仍是原来的窄栏）', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '', role: 'user' }));
    open('/assets');
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(screen.queryByText('这里会放点子、工具与试用、知识库，还没有接上。')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '工作台分区' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '分类' })).toBeInTheDocument();
  });
});
