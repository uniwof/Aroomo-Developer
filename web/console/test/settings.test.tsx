import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Settings } from '@/pages/Settings';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const members = [
  { id: 'm1', name: 'gpt-oss-20b', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true },
  { id: 'm2', name: 'Tiny', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false },
];

describe('设置页', () => {
  it('负责人：只列合格成员，改动后 PUT；敏感内容保护开关可切换', async () => {
    session.set('placeholder-session');
    const puts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts.push({ url, body: JSON.parse(String(init.body)) });
          return json(200, {});
        }
        if (url === '/api/members') return json(200, { members });
        if (url === '/api/settings/lead') return json(200, { leadId: null, effectiveLeadId: 'm1', auto: true });
        if (url === '/api/settings/security') return json(200, { sensitiveProtect: true });
        return json(404, {});
      }),
    );
    render(<Settings />);
    const select = await screen.findByRole('combobox', { name: '负责人' });
    expect(select.querySelectorAll('option')).toHaveLength(2);
    expect(screen.getByText('gpt-oss-20b（自动）')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'm1' } });
    await waitFor(() => expect(puts[0]).toEqual({ url: '/api/settings/lead', body: { leadId: 'm1' } }));

    const sw = await screen.findByRole('switch', { name: '敏感内容保护' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(puts.at(-1)).toEqual({ url: '/api/settings/security', body: { sensitiveProtect: false } }));
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('账号没有权限时说明原因，不显示开关', async () => {
    session.set('placeholder-session');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/settings/security') return json(403, { error: { code: 'FORBIDDEN', message: '没有权限执行这个操作' } });
        if (url === '/api/members') return json(200, { members: [] });
        return json(200, { leadId: null, effectiveLeadId: null, auto: true });
      }),
    );
    render(<Settings />);
    expect(await screen.findByText('这个账号还不能改这一项（等后台开放账号权限）')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('MCP 配置：显示并一键复制，内容只有占位符不含令牌', async () => {
    session.set('placeholder-session');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const config = { mcpServers: { aroomo: { url: 'https://x/mcp', headers: { Authorization: 'Bearer <YOUR_ARC_TOKEN>' } } } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/mcp/config') return json(200, { url: 'https://x/mcp', config });
        return json(403, { error: { code: 'FORBIDDEN', message: 'x' } });
      }),
    );
    render(<Settings />);
    const btn = await screen.findByRole('button', { name: '复制配置' });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(config, null, 2)));
    expect(await screen.findByText(/已复制/)).toBeInTheDocument();
  });

  it('打扰预算：显示今日统计，加减后 PUT', async () => {
    session.set('placeholder-session');
    const puts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts.push({ url, body: JSON.parse(String(init.body)) });
          return json(200, {});
        }
        if (url === '/api/interrupt-budget') return json(200, { daily: 3, today: { total: 4, loud: 3, quiet: 1 } });
        if (url === '/api/members') return json(200, { members: [] });
        return json(200, { leadId: null, effectiveLeadId: null, auto: true });
      }),
    );
    render(<Settings />);
    expect(await screen.findByText(/今天已来 4 张接管卡/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '增加一次' }));
    await waitFor(() => expect(puts[0]).toEqual({ url: '/api/interrupt-budget', body: { daily: 4 } }));
    expect(screen.getByLabelText('每天提醒次数')).toHaveTextContent('4');
  });
});
