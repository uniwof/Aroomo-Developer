/**
 * #316：从 Shell 进来（标签页里没记账号）先开的是空白新话题；问到是谁以后，
 * 当前话题空、也没草稿、她也没打字 → 自动换到她最近那段会话（她视力不好，看到一片空白会以为旧话没了）。
 * 她已经打了字或有自己的草稿 → 照 #291 不动，字还在。假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { saveConversations, saveDraft } from '@/chat/store';

const flags = vi.hoisted(() => ({ taskCards: false, quickReplies: false, convFilter: true, schedulePage: false, assistantDraft: false, assistants: false, savedChats: false, skeletonShimmer: false }));
// 一个开关一个常量（flags.ts）；用 getter 让各条测试中途改 flags.savedChats 生效
vi.mock('@/lib/flags', () => ({ get TASK_CARDS() { return flags.taskCards; }, get QUICK_REPLIES() { return flags.quickReplies; }, get CONV_FILTER() { return flags.convFilter; }, get SCHEDULE_PAGE() { return flags.schedulePage; }, get ASSISTANT_DRAFT() { return flags.assistantDraft; }, get ASSISTANTS() { return flags.assistants; }, get SAVED_CHATS() { return flags.savedChats; }, get SKELETON_SHIMMER() { return flags.skeletonShimmer; } }));

const ME = 'u-owner-1';
const CONV = 'aaaaaaaa-0000-4000-8000-000000000001';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const box = () => screen.getByLabelText('输入消息') as HTMLTextAreaElement;

/** Shell 打开：sessionStorage 里没账号；/api/auth/me 等 gate 放行才回 */
function openFromShell() {
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [] });
      if (url === '/api/auth/me') {
        await gate;
        return json({ kind: 'user', user: { id: ME, email: 'o@example.test', displayName: '', role: 'owner' } });
      }
      if (url === '/api/conversations/import') return json({ imported: 0, skipped: 0, ids: {} });
      if (url.startsWith('/api/conversations?'))
        return json({
          conversations: [
            {
              id: CONV,
              title: '周末去哪',
              model: 'aroomo',
              group: [],
              archived: false,
              unread: false,
              running: false,
              messageCount: 2,
              last: { role: 'assistant', preview: '去公园走走', createdAt: 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)' },
              readAt: null,
              createdAt: 'Thu 2026-11-05 1:00 PM CST (UTC+08:00)',
              updatedAt: 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)',
            },
          ],
          nextCursor: null,
        });
      if (url.endsWith('/messages?limit=200'))
        return json({
          messages: [
            { id: 'dddddddd-0000-4000-8000-000000000004', seq: 1, role: 'user', content: '周末去哪玩', createdAt: 'Thu 2026-11-05 1:59 PM CST (UTC+08:00)' },
            { id: 'eeeeeeee-0000-4000-8000-000000000005', seq: 2, role: 'assistant', content: '去公园走走\n\n— 负责人', createdAt: 'Thu 2026-11-05 2:00 PM CST (UTC+08:00)' },
          ],
          hasMore: false,
        });
      if (url.endsWith('/read')) return new Response(null, { status: 204 });
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

describe.each([true, false])('#316 问到是谁后换到最近那段（存库 %s）', (savedMode) => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    flags.savedChats = savedMode;
    // 本机模式：她自己那份本机会话（存库模式下这份会导入，Core 列表里也有）
    if (!savedMode) saveConversations([{ id: CONV, title: '周末去哪', model: 'aroomo', messages: [{ role: 'user', text: '周末去哪玩', at: 1 }, { role: 'assistant', text: '去公园走走' }], updatedAt: 2 }], ME);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('Core 晚回、她什么都没做 → 换到最近那段', async () => {
    const open = openFromShell();
    await screen.findByLabelText('输入消息');
    expect(screen.queryByText('周末去哪玩')).toBeNull();
    open();
    expect(await screen.findByText('周末去哪玩')).toBeInTheDocument();
    // 负责人 #319 小建议：读屏说一句（整页状态区），焦点不动
    await waitFor(() => expect(document.querySelector('[data-net-status]')!.textContent).toBe('打开了你最近的会话：周末去哪'));
  });

  it('Core 晚回，这期间她自己点了「新对话」→ 不换（负责人 #319 必改：只换页面自己开的那个空白话题）', async () => {
    const open = openFromShell();
    await screen.findByLabelText('输入消息');
    // 新对话 / 单独聊 / 新建群聊都走同一个 start()，各开一个新 id
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    await tick();
    open();
    await tick(300);
    expect(screen.queryByText('周末去哪玩')).toBeNull();
    expect(document.querySelector('[data-net-status]')!.textContent).toBe('');
  });

  it('Core 晚回、她已经打了几个字 → 不换，字还在', async () => {
    const open = openFromShell();
    await screen.findByLabelText('输入消息');
    fireEvent.change(box(), { target: { value: '我刚打' } });
    open();
    await tick(300);
    expect(screen.queryByText('周末去哪玩')).toBeNull();
    expect(box().value).toBe('我刚打');
  });

  it('她自己那份有没发出去的草稿 → 不换，草稿放回来', async () => {
    saveDraft('new:aroomo', '我自己的草稿', ME);
    const open = openFromShell();
    await screen.findByLabelText('输入消息');
    open();
    await waitFor(() => expect(box().value).toBe('我自己的草稿'));
    await tick(200);
    expect(screen.queryByText('周末去哪玩')).toBeNull();
  });
});
