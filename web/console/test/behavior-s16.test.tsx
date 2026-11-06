/**
 * Poke 行为审计 C15（切片 16）：群聊顶栏卡「查看群成员」只列这个群里的成员（/team?chat=<会话 id>，能直接打开、刷新不丢），
 * 一句说明 + 「查看所有成员」回到全部；返回回到这段群聊。不是群聊的对话照旧「查看所有成员」。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { pathOf, viewOf } from '@/chat/routes';

const M = (id: string, name: string) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}
const GROUP = { id: 'g1', title: '群聊：周末计划', model: 'aroomo', group: ['甲', '乙'], messages: [{ role: 'user', text: '大家好' }], updatedAt: 2 };
const PLAIN = { id: 'c1', title: '和负责人', model: 'aroomo', messages: [{ role: 'user', text: '在吗' }], updatedAt: 1 };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [M('m1', '甲'), M('m2', '乙'), M('m3', '丙')] });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const page = (path = '/chat', convs: unknown[] = [GROUP, PLAIN]) => {
  localStorage.setItem('aroomo.chat.v1', JSON.stringify(convs));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
      <Probe />
    </MemoryRouter>,
  );
};
const memberRow = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}`) });

describe('切片 16：C15 群聊只列群成员', () => {
  it('地址：/team?chat=<id> 和视图互转；不带 chat 还是 /team', () => {
    expect(pathOf({ kind: 'members', chat: 'g1' })).toBe('/team?chat=g1');
    expect(viewOf('/team', '?chat=g1')).toEqual({ kind: 'members', chat: 'g1' });
    expect(viewOf('/team', '')).toEqual({ kind: 'members' });
    expect(viewOf('/team', '?member=m1')).toEqual({ kind: 'member', id: 'm1' });
  });

  it('群聊顶栏卡「查看群成员」→ 只列甲、乙，不列丙；一句说明；「查看所有成员」回到全部', async () => {
    page();
    fireEvent.click(await screen.findByRole('button', { name: '对话信息' }, { timeout: 8000 }));
    fireEvent.click(screen.getByRole('button', { name: /查看群成员/ }));
    await waitFor(() => expect(where).toBe('/team?chat=g1'));
    await waitFor(() => expect(memberRow('甲')).not.toBeNull());
    expect(memberRow('乙')).not.toBeNull();
    expect(memberRow('丙')).toBeNull();
    expect(screen.getByText('只列「周末计划」这个群里的 2 位成员。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看所有成员' }));
    await waitFor(() => expect(where).toBe('/team'));
    await waitFor(() => expect(memberRow('丙')).not.toBeNull());
  });

  it('直接打开 /team?chat=g1（刷新）照样只列群成员；返回回到这段群聊', async () => {
    page('/team?chat=g1', [PLAIN, GROUP]);
    await waitFor(() => expect(memberRow('甲')).not.toBeNull(), { timeout: 8000 });
    expect(memberRow('丙')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /返回/ }));
    await waitFor(() => expect(where).toBe('/chat'));
    expect(await screen.findByRole('heading', { name: /周末计划/ })).toBeInTheDocument();
  });

  it('找不到这个群（会话已删 / 不是群聊）：列全部成员，不显示群说明', async () => {
    page('/team?chat=nope');
    await waitFor(() => expect(memberRow('丙')).not.toBeNull(), { timeout: 8000 });
    expect(memberRow('甲')).not.toBeNull();
    expect(screen.queryByText(/这个群里的/)).toBeNull();
  });

  it('不是群聊（交给负责人）：顶栏卡照旧「查看所有成员」→ /team', async () => {
    page('/chat', [PLAIN]);
    fireEvent.click(await screen.findByRole('button', { name: '对话信息' }, { timeout: 8000 }));
    fireEvent.click(screen.getByRole('button', { name: /查看所有成员/ }));
    await waitFor(() => expect(where).toBe('/team'));
  });
});
