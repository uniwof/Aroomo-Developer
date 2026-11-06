import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { AddMemberDialog, ApiView, FamilySection, GeneralSection, ProfileSection } from '../src/chat/views';
import { GroupNewPanel } from '../src/chat/group-new';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const member = (id: string, name: string) => ({ id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: false, online: true });

describe('API 页（落地文档第 10 章）', () => {
  it('Key 一行一个只显示末 4 位；替换只写新 Key；删除先问；模型和今天的用量各一组', async () => {
    const calls: { m: string; u: string; b?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        calls.push({ m: init?.method ?? 'GET', u, ...(init?.body ? { b: String(init.body) } : {}) });
        if (u === '/api/keys' && (init?.method ?? 'GET') === 'GET') return ok({ keys: [{ id: 'k1', name: '我的 Groq', sourceUrl: 'https://x', last4: 'ab12', status: 'active', updatedAt: '' }] });
        if (u === '/api/usage') return ok({ members: [{ memberId: 'm1', name: 'Kimi', today: { requests: 3, errors: 0, limited: 0 }, last7DaysRequests: 3, quota: { used: 3, limit: null, unit: '次/天' }, quotaKnown: false, ratio: null, state: 'unknown' }] });
        return ok({ key: {} });
      }),
    );
    render(<ApiView members={[member('m1', 'Kimi') as never]} />);
    expect(await screen.findByText('正常 · 末尾 ab12')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '模型' })).toBeInTheDocument();
    expect(await screen.findByText('今天 3 次')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '替换「我的 Groq」的 Key' }));
    const dlg = screen.getByRole('dialog', { name: '替换「我的 Groq」的 Key' });
    expect(within(dlg).queryByLabelText('名称（必填）')).toBeNull();
    fireEvent.change(within(dlg).getByLabelText('新的 Key（必填）'), { target: { value: 'sk-new' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '替换' }));
    await waitFor(() => expect(calls.some((c) => c.m === 'PATCH' && c.u === '/api/keys/k1' && c.b === JSON.stringify({ apiKey: 'sk-new' }))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '删除 Key「我的 Groq」' }));
    expect(calls.some((c) => c.m === 'DELETE')).toBe(false);
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除 Key「我的 Groq」？' })).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(calls.some((c) => c.m === 'DELETE' && c.u === '/api/keys/k1')).toBe(true));
  });
});

describe('添加成员弹窗（落地文档 8.2）', () => {
  it('基础模型必填、标签在框上方；带出的名字已填好；提交调 POST /api/members', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => (calls.push(`${init?.method} ${u} ${init?.body}`), ok({ member: member('x', 'gpt-oss-20b') }, 201))));
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<AddMemberDialog open preset="gpt-oss-20b" onClose={onClose} onAdded={onAdded} />);
    const dlg = screen.getByRole('dialog', { name: '添加成员' });
    expect(within(dlg).getByLabelText(/^基础模型（必填）/)).toHaveValue('gpt-oss-20b');
    fireEvent.click(within(dlg).getByRole('checkbox', { name: '写代码' }));
    fireEvent.click(within(dlg).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/members {"name":"gpt-oss-20b","capabilityTags":["code"]}']);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('设置补充（落地文档 11.1 11.4 11.5）', () => {
  it('个人资料：名字、登录账号只读，不放没有接口的保存键', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ kind: 'user', user: { id: 'u', email: 'mom@example.test', displayName: '妈妈', role: 'user' } })));
    render(<ProfileSection />);
    expect(await screen.findByText('mom@example.test')).toBeInTheDocument();
    expect(screen.getAllByText('妈妈').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull();
  });

  it('通用：家人人数、AI 成员数、总额度卡跳到用量；家人与邀请只列出，不放还没开放的添加按钮', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) =>
        u === '/api/users'
          ? ok({ users: [{ id: '1', email: 'mom@example.test', role: 'user', status: 'active' }, { id: '2', email: 'dad@example.test', role: 'user', status: 'disabled' }], invites: [] })
          : ok({ members: [] }),
      ),
    );
    const onUsage = vi.fn();
    render(<GeneralSection members={[member('m1', 'Kimi') as never]} onUsage={onUsage} />);
    expect(await screen.findByText('2 位')).toBeInTheDocument();
    expect(screen.getByText('1 位')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /看各成员用量/ }));
    expect(onUsage).toHaveBeenCalled();
    cleanup();
    render(<FamilySection />);
    expect(await screen.findByText('dad@example.test')).toBeInTheDocument();
    expect(screen.getByText('家人 · 已停用')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加家人/ })).toBeNull();
  });
});

describe('挑选成员新建（所有者 11-05 12:15）', () => {
  it('至少挑 1 位；挑 1 位是单聊，全选是几位一起', () => {
    const onStart = vi.fn();
    render(<GroupNewPanel members={[member('a', 'Kimi'), member('b', 'FreeBot')] as never} onStart={onStart} />);
    expect(screen.getByRole('button', { name: '开始对话（至少选 1 位）' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kimi' }));
    fireEvent.click(screen.getByRole('button', { name: '和 Kimi 单独聊' }));
    expect(onStart).toHaveBeenLastCalledWith(['Kimi']);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '开始对话（2 位）' }));
    expect(onStart).toHaveBeenLastCalledWith(['Kimi', 'FreeBot']);
  });
});
