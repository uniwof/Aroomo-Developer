/**
 * Skin/Bones 切片 1：SKIN_BONES 默认关（真开关，不 mock）。关着时界面上没有四区侧栏入口，/assets 地址落到对话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { pathOf, viewOf } from '@/chat/routes';
import { SKIN_BONES } from '@/lib/skinbones-flag';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [{ id: 'm1', name: '小建', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, role: 'Architect' }] });
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

describe('Skin/Bones 开关关着', () => {
  it('开关默认 false', () => {
    expect(SKIN_BONES).toBe(false);
  });
  it('/assets 地址当对话处理，assets 也不生成地址', () => {
    expect(viewOf('/assets', '')).toEqual({ kind: 'chat' });
    expect(pathOf({ kind: 'assets' })).toBe('/chat');
  });
  it('界面上没有四区侧栏，还是原来的窄栏', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '工作台分区' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '分类' })).toBeInTheDocument();
  });
  it('直接打开 /assets 落到对话', async () => {
    render(
      <MemoryRouter initialEntries={['/assets']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '工作台分区' })).not.toBeInTheDocument();
  });
  // 切片 2：抽屉也在同一个开关后面
  it('界面上没有抽屉入口', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开示例详情' })).not.toBeInTheDocument();
  });
  // 切片 3：角色泳道也在同一个开关后面
  it('驾驶舱里没有角色泳道，驾驶舱本身照常', async () => {
    render(
      <MemoryRouter initialEntries={['/console']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('概览')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '角色泳道' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Architect/ })).not.toBeInTheDocument();
  });
  it('地址里带 ?drawer= 也不开抽屉', async () => {
    render(
      <MemoryRouter initialEntries={['/assets?drawer=preview&w=640']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
