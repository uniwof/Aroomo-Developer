/** F-018 补测（负责人 #312 小建议）：存库模式下列表还没到（remote === null）时先显示平常那句，不闪欢迎；列表到了且是空的再换成欢迎 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

vi.mock('@/lib/flags', () => ({ FLAGS: { taskCards: true, quickReplies: false, convFilter: true, schedulePage: true, assistantDraft: true, assistants: true, savedChats: true, skeletonShimmer: false } }));

const WELCOME = '你好，我是负责人。想做什么，直接在下面说，我来回答，或者交给合适的成员。想找某一位，就 @ 它的名字。';
const USUAL = '所有成员都在。直接说，负责人回答；@ 谁，谁回答。';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('欢迎引导：存库模式列表还没到', () => {
  let open: () => void = () => {};
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const gate = new Promise<void>((r) => (open = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/conversations?')) {
          await gate;
          return json({ conversations: [], nextCursor: null });
        }
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('列表没到：平常那句，不显示欢迎；到了且一句话都没说过：换成欢迎', async () => {
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(USUAL)).toBeInTheDocument();
    expect(screen.queryByText(WELCOME)).toBeNull();
    open();
    expect(await screen.findByText(WELCOME)).toBeInTheDocument();
    expect(screen.queryByText(USUAL)).toBeNull();
  });
});
