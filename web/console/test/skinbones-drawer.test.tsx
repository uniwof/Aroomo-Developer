/**
 * Skin/Bones 切片 2（开关 SKIN_BONES 打开，mock）：右侧抽屉两档宽、Esc / 关闭键 / 点背景能关、焦点回到打开它的按钮，
 * 开关状态和地址查询参数双向同步（地址 → 抽屉、抽屉 → 地址，刷新和前进后退复原）。
 * 关着的情况（没有入口、地址里的 ?drawer 不生效）见 skinbones-off.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

vi.mock('@/lib/skinbones-flag', () => ({ SKIN_BONES: true }));
vi.mock('@/lib/work-flag', () => ({ WORK: false }));
vi.mock('@/lib/flags', () => ({ TASK_CARDS: false, QUICK_REPLIES: false, CONV_FILTER: false, SCHEDULE_PAGE: false, ASSISTANT_DRAFT: false, ASSISTANTS: false, SAVED_CHATS: false, SKELETON_SHIMMER: false }));

const { ChatPage } = await import('@/chat/ChatPage');
const { drawerOf, withDrawer, withoutDrawer } = await import('@/chat/drawer-query');

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  // jsdom 没有实现 <dialog>：补上 showModal / close，行为和平台一致（open 属性 + close 事件）
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      if (url.startsWith('/api/inbox/unread-count')) return json({ total: 0 });
      if (url.startsWith('/api/capabilities')) return json({ items: [] });
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

const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>,
  );
const drawer = () => screen.queryByRole('dialog');

/** 测试用：把当前地址的 search 写出来，再给一个「后退」「前进」（= 浏览器按钮） */
function Probe() {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <>
      <output data-testid="search">{loc.search}</output>
      <button type="button" data-testid="back" onClick={() => nav(-1)} />
      <button type="button" data-testid="fwd" onClick={() => nav(1)} />
    </>
  );
}
const openWithProbe = (entries: string[], index = entries.length - 1) =>
  render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <ChatPage />
      <Probe />
    </MemoryRouter>,
  );
const search = () => screen.getByTestId('search').textContent;

describe('抽屉 ↔ 地址：纯函数契约', () => {
  it('?drawer=<id> 是常规宽，加 w=640 是宽档，没有就是关着', () => {
    expect(drawerOf('')).toBeNull();
    expect(drawerOf('?member=m1')).toBeNull();
    expect(drawerOf('?drawer=preview')).toEqual({ id: 'preview', wide: false });
    expect(drawerOf('?drawer=preview&w=640')).toEqual({ id: 'preview', wide: true });
    // 只认 640 为宽档，别的宽度一律当常规
    expect(drawerOf('?drawer=preview&w=999')).toEqual({ id: 'preview', wide: false });
  });
  it('坏 id 当关着处理，不报错', () => {
    expect(drawerOf('?drawer=')).toBeNull();
    expect(drawerOf('?drawer=坏的')).toBeNull();
    expect(drawerOf(`?drawer=${'a'.repeat(41)}`)).toBeNull();
  });
  it('写回地址时只动 drawer 和 w，别的参数原样留着', () => {
    expect(withDrawer('', { id: 'preview', wide: false })).toBe('?drawer=preview');
    expect(withDrawer('', { id: 'preview', wide: true })).toBe('?drawer=preview&w=640');
    expect(withDrawer('?member=m1', { id: 'preview', wide: true })).toBe('?member=m1&drawer=preview&w=640');
    expect(withDrawer('?member=m1&drawer=preview&w=640', null)).toBe('?member=m1');
    expect(withDrawer('?drawer=preview&w=640', null)).toBe('');
    // 加宽 / 变窄都是改同一个参数，不会留下两个 w
    expect(withDrawer('?drawer=preview&w=640', { id: 'preview', wide: false })).toBe('?drawer=preview');
    expect(withoutDrawer('?drawer=preview&w=640&member=m1')).toBe('?member=m1');
  });
});

describe('地址 → 抽屉（刷新、直接打开、前进后退）', () => {
  it('没有 query 时默认关着', async () => {
    open('/assets');
    expect(await screen.findByText('这里会放点子、工具与试用、知识库，还没有接上。')).toBeInTheDocument();
    expect(drawer()).not.toBeInTheDocument();
  });
  it('带 ?drawer= 直接打开（= 刷新后复原）就有抽屉，常规宽', async () => {
    open('/assets?drawer=preview');
    const d = await screen.findByRole('dialog');
    expect(d).toHaveAccessibleName('详情');
    expect(d.className).toBe('sdrawer');
  });
  it('带 w=640 复原成宽档', async () => {
    open('/assets?drawer=preview&w=640');
    expect(await screen.findByRole('dialog')).toHaveClass('sdrawer-wide');
  });
  it('地址里是没见过的抽屉 id：当关着处理，页面照常', async () => {
    open('/assets?drawer=nosuch');
    expect(await screen.findByText('这里会放点子、工具与试用、知识库，还没有接上。')).toBeInTheDocument();
    expect(drawer()).not.toBeInTheDocument();
  });
});

describe('抽屉 → 地址，以及关闭', () => {
  it('点入口开抽屉；关闭键关上后焦点回到那个按钮', async () => {
    open('/assets');
    const entry = await screen.findByRole('button', { name: '打开示例详情' });
    entry.focus();
    fireEvent.click(entry);
    const d = await screen.findByRole('dialog');
    // 打开后焦点在抽屉里（第一个可操作元素 = 关闭键）
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(drawer()).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '打开示例详情' })).toHaveFocus();
    expect(d).not.toBeInTheDocument();
  });
  it('Esc 关得掉，焦点也回去', async () => {
    open('/assets');
    const entry = await screen.findByRole('button', { name: '打开示例详情' });
    entry.focus();
    fireEvent.click(entry);
    const d = await screen.findByRole('dialog');
    fireEvent.keyDown(d, { key: 'Escape' });
    expect(drawer()).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '打开示例详情' })).toHaveFocus();
  });
  it('点背景关得掉', async () => {
    open('/assets?drawer=preview');
    const d = await screen.findByRole('dialog');
    fireEvent.click(d);
    expect(drawer()).not.toBeInTheDocument();
  });
  it('在抽屉里加宽 / 改回常规，两档都能来回切', async () => {
    open('/assets?drawer=preview');
    fireEvent.click(await screen.findByRole('button', { name: '加宽' }));
    expect(await screen.findByRole('dialog')).toHaveClass('sdrawer-wide');
    fireEvent.click(screen.getByRole('button', { name: '改回常规宽度' }));
    expect(screen.getByRole('dialog').className).toBe('sdrawer');
  });
  it('抽屉是弹窗语义：有名字、aria-modal', async () => {
    open('/assets?drawer=preview');
    const d = await screen.findByRole('dialog');
    expect(d.tagName).toBe('DIALOG');
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleName('详情');
  });
});

describe('抽屉状态 → 地址', () => {
  it('打开写 ?drawer=preview，加宽写 w=640，关上把两个参数都去掉', async () => {
    openWithProbe(['/assets']);
    fireEvent.click(await screen.findByRole('button', { name: '打开示例详情' }));
    await screen.findByRole('dialog');
    expect(search()).toBe('?drawer=preview');
    fireEvent.click(screen.getByRole('button', { name: '加宽' }));
    expect(search()).toBe('?drawer=preview&w=640');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(search()).toBe('');
  });
});

describe('前进后退', () => {
  it('后退关抽屉、前进再打开（宽档也复原）', async () => {
    openWithProbe(['/assets', '/assets?drawer=preview&w=640']);
    expect(await screen.findByRole('dialog')).toHaveClass('sdrawer-wide');
    fireEvent.click(screen.getByTestId('back'));
    expect(drawer()).not.toBeInTheDocument();
    expect(search()).toBe('');
    fireEvent.click(screen.getByTestId('fwd'));
    expect(await screen.findByRole('dialog')).toHaveClass('sdrawer-wide');
  });
  it('打开占一步历史、切宽档不占：开 → 加宽 → 后退一次就关上', async () => {
    openWithProbe(['/assets']);
    fireEvent.click(await screen.findByRole('button', { name: '打开示例详情' }));
    fireEvent.click(await screen.findByRole('button', { name: '加宽' }));
    expect(search()).toBe('?drawer=preview&w=640');
    fireEvent.click(screen.getByTestId('back'));
    expect(drawer()).not.toBeInTheDocument();
    expect(search()).toBe('');
  });
  it('Esc 只写一步历史：关上后再后退回到开着的样子', async () => {
    openWithProbe(['/assets', '/assets?drawer=preview']);
    const d = await screen.findByRole('dialog');
    fireEvent.keyDown(d, { key: 'Escape' });
    expect(search()).toBe('');
    fireEvent.click(screen.getByTestId('back'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('back'));
    expect(drawer()).not.toBeInTheDocument();
  });
});

describe('抽屉不影响四区', () => {
  it('家人账号看不到抽屉（和 /assets 一样只给所有者）', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '', role: 'user' }));
    open('/assets?drawer=preview');
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(drawer()).not.toBeInTheDocument();
  });
});
