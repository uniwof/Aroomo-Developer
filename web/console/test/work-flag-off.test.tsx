/**
 * /work 切片 1：WORK 默认关（真开关，不 mock）。关着时 /work 地址落到对话、不请求 /api/work/*。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { viewOf } from '@/chat/routes';
import { WORK } from '@/lib/work-flag';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
let urls: string[];
beforeEach(() => {
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '', role: 'owner' }));
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url === '/api/members') return json({ members: [] });
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

describe('/work 开关关着', () => {
  it('开关默认 false', () => {
    expect(WORK).toBe(false);
  });
  it('/work 地址当对话处理', () => {
    expect(viewOf('/work', '')).toEqual({ kind: 'chat' });
    expect(viewOf('/work/p1', '?v=v1')).toEqual({ kind: 'chat' });
  });
  it('直接打开 /work 落到对话，不请求 /api/work', async () => {
    render(
      <MemoryRouter initialEntries={['/work']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('输入消息')).toBeInTheDocument();
    expect(urls.some((u) => u.includes('/api/work'))).toBe(false);
  });
});
