/**
 * #377 第 2 轮 C1：'owner' 那份只并进 Core 确认是所有者的账号。家人和所有者共用浏览器、直接登录控制台时，
 * 所有者的本机会话不能并进家人账号。纯函数 4 种输入 + 挂载 ChatPage（本机模式 / 存库模式）家人不并、所有者并（正向对照）。
 * 假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { loadConversations, saveConversations, shouldMergeOwnerShare, type Conversation } from '@/chat/store';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false, skeletonShimmer: false }));
vi.mock('@/lib/flags', () => ({ get TASK_CARDS() { return flags.taskCards; }, get QUICK_REPLIES() { return flags.quickReplies; }, get CONV_FILTER() { return flags.convFilter; }, get SCHEDULE_PAGE() { return flags.schedulePage; }, get ASSISTANT_DRAFT() { return flags.assistantDraft; }, get ASSISTANTS() { return flags.assistants; }, get SAVED_CHATS() { return flags.savedChats; }, get SKELETON_SHIMMER() { return flags.skeletonShimmer; } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OWNER = 'u-owner-1';
const KID = 'u-kid-2';
const A = 'cccccccc-0000-4000-8000-0000000000a1';
const B = 'cccccccc-0000-4000-8000-0000000000b2';
const conv = (id: string, title: string): Conversation => ({ id, title, model: 'aroomo', messages: [{ role: 'user', text: `${title}的问题`, at: 1 }, { role: 'assistant', text: '回答' }], updatedAt: 2 });
const mergedKey = (acct: string) => `aroomo.chat.v1.owner-merged-ids:u:${acct}`;

/** /api/auth/me 回 id 账号，ownerAccount 按参数 */
function stubCore(id: string, ownerAccount: boolean) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/auth/me') return json({ kind: 'user', ownerAccount, user: { id, email: 'x@example.test', role: ownerAccount ? 'owner' : 'admin' } });
      if (url === '/api/conversations/import') return json({ imported: 0, skipped: 0, ids: {} });
      if (url.startsWith('/api/conversations?')) return json({ conversations: [], nextCursor: null });
      return json({}, 404);
    }),
  );
  return calls;
}
const renderPage = () =>
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );

describe('#377 C1 shouldMergeOwnerShare（纯函数）', () => {
  it('只有拿到账号 id 且 owner=true 才并', () => {
    expect(shouldMergeOwnerShare(OWNER, { owner: true })).toBe(true);
    expect(shouldMergeOwnerShare(KID, { owner: false })).toBe(false);
    expect(shouldMergeOwnerShare(null, { owner: true })).toBe(false);
    expect(shouldMergeOwnerShare(OWNER, null)).toBe(false);
  });
});

describe.each([
  { mode: '本机模式（SAVED_CHATS=false）', saved: false },
  { mode: '存库模式（SAVED_CHATS=true）', saved: true },
])('#377 C1 挂载 ChatPage：$mode', ({ saved }) => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = saved;
    saveConversations([conv(A, 'A-owner'), conv(B, 'B-owner')], 'owner');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('家人账号（ownerAccount=false）直接登录控制台：owner 那份不并进家人账号，不记已并集合，owner 那份原样', async () => {
    const calls = stubCore(KID, false);
    renderPage();
    await waitFor(() => expect(calls).toContain('/api/auth/me'), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 50));
    const kidIds = loadConversations(KID).map((c) => c.id);
    expect(kidIds).not.toContain(A);
    expect(kidIds).not.toContain(B);
    expect(localStorage.getItem(mergedKey(KID))).toBeNull();
    expect(loadConversations('owner').map((c) => c.id).sort()).toEqual([A, B].sort());
  }, 20000);

  it('正向对照：所有者账号（ownerAccount=true）挂载后两段并进她账号那份', async () => {
    stubCore(OWNER, true);
    renderPage();
    await waitFor(() => expect(loadConversations(OWNER).map((c) => c.id).sort()).toEqual([A, B].sort()), { timeout: 10000 });
    expect(localStorage.getItem(mergedKey(OWNER))).not.toBeNull();
  }, 20000);
});
