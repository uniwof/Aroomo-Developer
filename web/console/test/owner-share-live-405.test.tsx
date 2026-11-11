/**
 * #405：标签页里已记着账号（sessionStorage 有 id，如直接在控制台登录）时，本机模式挂载时列表读的是她账号那份；
 * 之后「owner 那份」并进来的会话要马上出现在当前列表，不等下次打开。家人账号不并（越权对照）。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { saveConversations, type Conversation } from '@/chat/store';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false, skeletonShimmer: false }));
vi.mock('@/lib/flags', () => ({ get TASK_CARDS() { return flags.taskCards; }, get QUICK_REPLIES() { return flags.quickReplies; }, get CONV_FILTER() { return flags.convFilter; }, get SCHEDULE_PAGE() { return flags.schedulePage; }, get ASSISTANT_DRAFT() { return flags.assistantDraft; }, get ASSISTANTS() { return flags.assistants; }, get SAVED_CHATS() { return flags.savedChats; }, get SKELETON_SHIMMER() { return flags.skeletonShimmer; } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OWNER = 'u-owner-1';
const KID = 'u-kid-2';
const MINE = 'cccccccc-0000-4000-8000-0000000000a1';
const SHARED = 'cccccccc-0000-4000-8000-0000000000b2';
const conv = (id: string, title: string): Conversation => ({ id, title, model: 'aroomo', messages: [{ role: 'user', text: `${title}的问题`, at: 1 }, { role: 'assistant', text: '回答' }], updatedAt: 2 });

function stubCore(id: string, ownerAccount: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/auth/me') return json({ kind: 'user', ownerAccount, user: { id, email: 'x@example.test', role: ownerAccount ? 'owner' : 'admin' } });
      return json({}, 404);
    }),
  );
}
const asAcct = (id: string, role: string) => sessionStorage.setItem('aroomo.console.user', JSON.stringify({ id, email: 'x@example.test', displayName: '', role }));
const renderPage = () =>
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );

describe('#405 本机模式：标签页已记着账号时，并入的会话立即出现在列表', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = false;
    saveConversations([conv(MINE, '她自己那段')], OWNER);
    saveConversations([conv(SHARED, '旧共用那段')], 'owner');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('所有者：挂载时只读到她自己那段；Core 确认后 owner 那份并进来，当前列表马上有', async () => {
    asAcct(OWNER, 'owner');
    stubCore(OWNER, true);
    renderPage();
    expect((await screen.findAllByText('她自己那段')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('旧共用那段').length).toBeGreaterThan(0), { timeout: 10000 });
  }, 20000);

  it('越权对照：家人账号（ownerAccount=false）不并，列表里不出现 owner 那份的会话', async () => {
    saveConversations([conv(MINE, '家人自己那段')], KID);
    asAcct(KID, 'admin');
    stubCore(KID, false);
    renderPage();
    expect((await screen.findAllByText('家人自己那段')).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryAllByText('旧共用那段')).toHaveLength(0);
  }, 20000);
});
