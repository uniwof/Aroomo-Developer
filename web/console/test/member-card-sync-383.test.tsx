/** #383：成员页悬停卡的状态与行内状态同源（同一位成员两处一致），Core 卡片说「可用」也不能和行内打架 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const member = { id: 'e', name: 'Eps', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, activity: { state: 'unknown', reason: '没有可用的 Key' } };
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members: [member] });
      if (url === '/api/members/e/card') return json({ name: 'Eps', type: ['text'], status: '可用', remaining: { value: null, unit: null, source: '未知' } });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('#383 悬停卡与行内同源', () => {
  it('同一 mock 成员：卡片「状态：」后面的字 = 行内状态；余量未知圆环走「未知」分支', async () => {
    render(<MemoryRouter initialEntries={['/team']}><ChatPage /></MemoryRouter>);
    const find = async () => (await within(screen.getByRole('main')).findByText('Eps')).closest('button')!;
    let row = await find();
    expect(row).toHaveTextContent('不可用 · 没有可用的 Key');
    expect(row.querySelector('[data-testid=avatar-ring-unknown]')).toBeTruthy();
    expect(row.querySelector('[role=img]')!.getAttribute('aria-label')).toContain('余量未知');
    // 悬停卡是懒加载块：等它换上再聚焦
    await vi.waitFor(async () => expect((await find()).parentElement!.tagName).toBe('SPAN'));
    row = await find();
    await act(async () => { row.focus(); await new Promise((r) => setTimeout(r, 0)); });
    await screen.findByText('余量：未知');
    const tip = screen.getByRole('tooltip');
    const inline = row.querySelector('.row-hint')!.textContent!;
    expect(tip.textContent).toContain(`状态：${inline}`);
    expect(tip.textContent).not.toContain('状态：可用');
  });
});
