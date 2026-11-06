/** Poke Core 数据 切片 2：成员列表 / 详情只显示 Core 给的状态文字（§5），不画百分比、不造「就绪」 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

const M = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, ...extra });
let members: Record<string, unknown>[] = [];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url === '/api/members' ? json({ members }) : new Response('{}', { status: 404 }))),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>,
  );
const main = () => screen.getByRole('main');

describe('切片 2：成员状态文字', () => {
  it('五种状态各显示自己的字；没有 activity 时照旧（在线/离线），不凭空说「就绪」', async () => {
    members = [
      M('a', 'Alpha', { activity: { state: 'working', reason: '正在跑助手的一步', since: '2026-11-06T02:00:00Z' } }),
      M('b', 'Beta', { activity: { state: 'cooldown', reason: '供应商刚限流过（429），稍后再试' } }),
      M('c', 'Gamma', { activity: { state: 'depleted', reason: '今天的次数已到你填的上限' } }),
      M('d', 'Delta', { activity: { state: 'ready' } }),
      M('e', 'Eps', { activity: { state: 'unknown', reason: '没有可用的 Key' } }),
      M('f', 'Old', { online: false }),
    ];
    at('/team');
    const row = async (name: string) => (await within(main()).findByText(name)).closest('button')!;
    expect(await row('Alpha')).toHaveTextContent('工作中');
    expect(await row('Beta')).toHaveTextContent('冷却');
    expect(await row('Gamma')).toHaveTextContent('耗尽');
    expect(await row('Delta')).toHaveTextContent('就绪');
    expect(await row('Eps')).toHaveTextContent('状态未知');
    expect(await row('Old')).toHaveTextContent('离线');
    expect(main().textContent).not.toMatch(/\d+%/);
  });

  it('详情里写出状态、依据和时间（读屏能读到，不靠颜色）', async () => {
    members = [M('b', 'Beta', { activity: { state: 'cooldown', reason: '供应商刚限流过（429），稍后再试', since: '2026-11-06T02:05:00Z' } })];
    at('/team?member=b');
    const st = await within(main()).findByText(/冷却/);
    expect(st.textContent).toContain('供应商刚限流过（429），稍后再试');
    expect(st.textContent).toMatch(/起/);
  });
});
