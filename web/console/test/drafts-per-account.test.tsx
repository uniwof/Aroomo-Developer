/**
 * #291：没发出去的草稿（aroomo.chat.drafts.v1）按账号分开存，键名带账号 id（同 store.chatKey）。
 * 旧的共用草稿不搬、不删；不知道是哪个账号时照旧用共用那份。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { loadDraft, saveDraft } from '@/chat/store';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false, skeletonShimmer: false }));
// 一个开关一个常量（flags.ts）；用 getter 让各条测试中途改 flags.savedChats 生效
vi.mock('@/lib/flags', () => ({ get TASK_CARDS() { return flags.taskCards; }, get QUICK_REPLIES() { return flags.quickReplies; }, get CONV_FILTER() { return flags.convFilter; }, get SCHEDULE_PAGE() { return flags.schedulePage; }, get ASSISTANT_DRAFT() { return flags.assistantDraft; }, get ASSISTANTS() { return flags.assistants; }, get SAVED_CHATS() { return flags.savedChats; }, get SKELETON_SHIMMER() { return flags.skeletonShimmer; } }));

const SHARED = 'aroomo.chat.drafts.v1';
const A = 'u-mom-1';
const B = 'u-kid-2';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function openAs(id: string) {
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id, email: `${id}@example.test`, displayName: '', role: 'user' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/auth/me') return json({ kind: 'user', user: { id, email: `${id}@example.test`, displayName: '', role: 'user' } });
      return json({}, 404);
    }),
  );
  return render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );
}
const box = () => screen.getByLabelText('输入消息') as HTMLTextAreaElement;

describe('#291 草稿按账号分开', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = false;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('store：键名带账号 id；别的账号读不到；共用那份不动', () => {
    localStorage.setItem(SHARED, JSON.stringify({ c1: '以前共用的草稿' }));
    saveDraft('c1', '妈妈写到一半', A);
    expect(loadDraft('c1', A)).toBe('妈妈写到一半');
    expect(loadDraft('c1', B)).toBe('');
    expect(JSON.parse(localStorage.getItem(`${SHARED}:u:${A}`)!)).toEqual({ c1: '妈妈写到一半' });
    // 旧的共用草稿不搬、不删
    expect(JSON.parse(localStorage.getItem(SHARED)!)).toEqual({ c1: '以前共用的草稿' });
    expect(loadDraft('c1')).toBe('以前共用的草稿');
    saveDraft('c1', '', A);
    expect(loadDraft('c1', A)).toBe('');
    expect(loadDraft('c1')).toBe('以前共用的草稿');
  });

  it('对话页：一个账号没发出去的话，换另一个账号打开看不到；换回来还在', async () => {
    const a = openAs(A);
    await screen.findByLabelText('输入消息');
    fireEvent.change(box(), { target: { value: '妈妈写到一半' } });
    await tick();
    a.unmount();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    expect(localStorage.getItem(SHARED)).toBeNull();

    const b = openAs(B);
    await screen.findByLabelText('输入消息');
    await tick(150);
    expect(box().value).toBe('');
    b.unmount();
    sessionStorage.clear();
    vi.unstubAllGlobals();

    openAs(A);
    await waitFor(() => expect(box().value).toBe('妈妈写到一半'));
  });
  /** Core 晚回：先按「不知道是谁」打开（用共用那份），gate 放行后 Core 说是 id */
  function openLate(id: string) {
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/members') return json({ members: [] });
        if (url === '/api/auth/me') {
          await gate;
          return json({ kind: 'user', user: { id, email: `${id}@example.test`, displayName: '', role: 'user' } });
        }
        if (url.startsWith('/api/conversations?')) return json({ conversations: [], nextCursor: null });
        return json({}, 404);
      }),
    );
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    return open;
  }

  it('账号刚问到：输入框里是从共用那份读进来、没改过的草稿，换成她自己那份（没有就清空），不存进她的账号（负责人 #299 必改）', async () => {
    localStorage.setItem(SHARED, JSON.stringify({ 'new:aroomo': '家人写的' }));
    const open = openLate(A);
    await waitFor(() => expect(box().value).toBe('家人写的'));
    open();
    await waitFor(() => expect(box().value).toBe(''));
    await tick(150);
    expect(localStorage.getItem(`${SHARED}:u:${A}`) ?? '').not.toContain('家人写的');
    expect(JSON.parse(localStorage.getItem(SHARED)!)).toEqual({ 'new:aroomo': '家人写的' });
  });

  it('存库模式同样：账号刚问到，没改过的共用草稿换掉，不存进她的账号', async () => {
    flags.savedChats = true;
    localStorage.setItem(SHARED, JSON.stringify({ 'new:aroomo': '家人写的' }));
    const open = openLate(A);
    await waitFor(() => expect(box().value).toBe('家人写的'));
    open();
    await waitFor(() => expect(box().value).toBe(''));
    fireEvent.change(box(), { target: { value: '她自己写' } });
    await waitFor(() => expect(loadDraft('new:aroomo', A)).toBe('她自己写'));
    expect(localStorage.getItem(`${SHARED}:u:${A}`) ?? '').not.toContain('家人写的');
  });

  it('账号刚问到：她自己那份有草稿就换成她的', async () => {
    localStorage.setItem(SHARED, JSON.stringify({ 'new:aroomo': '家人写的' }));
    saveDraft('new:aroomo', '我自己的草稿', A);
    const open = openLate(A);
    await waitFor(() => expect(box().value).toBe('家人写的'));
    open();
    await waitFor(() => expect(box().value).toBe('我自己的草稿'));
  });

  it.each([false, true])('账号问到之前她自己打了字：是她的，留着，存进她的账号（存库 %s）', async (savedMode) => {
    flags.savedChats = savedMode;
    localStorage.setItem(SHARED, JSON.stringify({ 'new:aroomo': '家人写的' }));
    const open = openLate(A);
    await waitFor(() => expect(box().value).toBe('家人写的'));
    fireEvent.change(box(), { target: { value: '我刚打的' } });
    open();
    await tick(200);
    expect(box().value).toBe('我刚打的');
    fireEvent.change(box(), { target: { value: '我刚打的字' } });
    await waitFor(() => expect(loadDraft('new:aroomo', A)).toBe('我刚打的字'));
  });
});
