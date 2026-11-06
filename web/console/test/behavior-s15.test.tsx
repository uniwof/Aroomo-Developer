/**
 * Poke 行为规范 切片 15（审计验收清单第 7、9 项的前端余项 + 能力地图不造数）：
 * - 第 7 项：成员详情只给在职成员「单独聊 / 点名」，停用、候选的说一句为什么（不留点了没用的按钮）
 * - 第 9 项：资源库（Hub）把现有的几类列在一起：能力地图、工具、API Key、外部接入（MCP，/hub/mcp）
 * - 能力地图：/api/capabilities 回 404/501 时显示空状态，不再放示例数字
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { CapabilityMap } from '@/components/CapabilityMap';

const M = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, ...extra });
let members: unknown[] = [];
let capStatus = 200;
let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const owner = () => sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'owner@example.test', displayName: '测试', role: 'owner' }));
beforeEach(() => {
  localStorage.clear();
  owner();
  capStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/members') return json({ members });
      if (url === '/api/capabilities') return capStatus === 200 ? json({ items: [{ id: 'c1', name: 'Kimi', kind: 'text', provider: 'p', access: 'free' }] }) : json({ error: { code: 'NOT_FOUND', message: 'x' } }, capStatus);
      if (url === '/api/library') return json({ items: [] });
      if (url === '/api/mcp/config') return json({ config: { mcpServers: {} } });
      return json({}, 404);
    }),
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
      <Probe />
    </MemoryRouter>,
  );

describe('切片 15 · 第 7 项：成员详情不留点了没用的按钮', () => {
  it('在职成员：单独聊、点名都在', async () => {
    members = [M('m1', 'Kimi')];
    at('/team?member=m1');
    const main = screen.getByRole('main');
    expect(await within(main).findByRole('button', { name: '和 Kimi 单独对话' })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: '在当前对话里点名 Kimi' })).toBeInTheDocument();
  });

  it('已停用：没有单独聊、点名，说一句启用后才能聊，启用按钮还在', async () => {
    members = [M('m1', 'Kimi'), M('m3', '停用乙', { enabled: false })];
    at('/team?member=m3');
    const main = screen.getByRole('main');
    expect(await within(main).findByRole('button', { name: '启用 停用乙' })).toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: '和 停用乙 单独对话' })).toBeNull();
    expect(within(main).queryByRole('button', { name: '在当前对话里点名 停用乙' })).toBeNull();
    expect(within(main).getByText('停用乙 已停用，启用后才能对话。')).toBeInTheDocument();
  });

  it('候选：没有单独聊、点名，说一句入职后才能聊，入职按钮还在', async () => {
    members = [M('m1', 'Kimi'), M('m2', '候选甲', { status: 'candidate' })];
    at('/team?member=m2');
    const main = screen.getByRole('main');
    expect(await within(main).findByRole('button', { name: '让 候选甲 入职' })).toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: '和 候选甲 单独对话' })).toBeNull();
    expect(within(main).getByText('候选甲 还是候选，入职后才能对话。')).toBeInTheDocument();
  });
});

describe('切片 15 · 第 9 项：资源库把几类放在一起', () => {
  it('/hub 列出能力地图、工具、API Key、外部接入，点了各去各的地址', async () => {
    members = [M('m1', 'Kimi')];
    at('/hub');
    const main = screen.getByRole('main');
    const nav = await within(main).findByRole('region', { name: '资源库里还有' });
    const go: [string, string][] = [
      ['能力地图', '/hub/capabilities'],
      ['工具', '/hub/tools'],
      ['API Key', '/hub/keys'],
      ['外部接入（MCP）', '/hub/mcp'],
    ];
    for (const [name, path] of go) {
      cleanup();
      at('/hub');
      const n = await within(screen.getByRole('main')).findByRole('region', { name: '资源库里还有' });
      fireEvent.click(within(n).getByRole('button', { name: new RegExp(`^${name.replace(/[()（）]/g, '.')}`) }));
      await waitFor(() => expect(where).toBe(path));
    }
    expect(nav).toBeTruthy();
  }, 20000);

  it('/hub/mcp 直接打开是外部接入（MCP 配置 + 连接密码），返回回资源库', async () => {
    members = [M('m1', 'Kimi')];
    at('/hub/mcp');
    const main = screen.getByRole('main');
    await waitFor(() => expect(within(main).getAllByRole('heading', { level: 1 })[0]).toHaveTextContent('外部接入'));
    expect(await within(main).findByRole('button', { name: '复制配置' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回资源库' }));
    await waitFor(() => expect(where).toBe('/hub'));
  });

  it('家人账号打开 /hub/mcp 落到对话', async () => {
    sessionStorage.setItem('aroomo.console.user', JSON.stringify({ email: 'kid@example.test', displayName: '家人', role: 'user' }));
    members = [M('m1', 'Kimi')];
    at('/hub/mcp');
    await waitFor(() => expect(where).toBe('/chat'));
  });
});

describe('切片 15：能力地图不造数', () => {
  for (const status of [404, 501]) {
    it(`接口回 ${status}：空状态一句话，不出示例数字`, async () => {
      capStatus = status;
      render(<CapabilityMap />);
      expect(await screen.findByText('能力清单还读不到，等后台接上就会列在这里。')).toBeInTheDocument();
      expect(screen.queryByTestId('cap-summary')).toBeNull();
      expect(screen.queryByText(/示例数据/)).toBeNull();
      expect(screen.queryByText('永久免费')).toBeNull();
      expect(screen.queryByText(/gpt-oss/)).toBeNull();
    });
  }
});
