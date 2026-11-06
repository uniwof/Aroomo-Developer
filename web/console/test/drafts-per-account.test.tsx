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
vi.mock('@/lib/flags', () => ({ FLAGS: flags }));

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
});
