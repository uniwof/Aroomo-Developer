/** Poke Core 数据 切片 3：New Member 的五项（基础模型=名字、角色、系统提示词、头像、擅长）+ 必填校验 + 防重复 + 失败保留 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AddMemberDialog } from '@/chat/views';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('切片 3：添加成员', () => {
  it('有 基础模型 / 角色 / 系统提示词 / 头像 四个框（标签在上方）；基础模型可从能力地图挑；没填时「添加」不能点', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (u === '/api/capabilities' ? json({ items: [{ name: 'Kimi K2' }, { name: 'Qwen' }] }) : json({}, 404))));
    render(<AddMemberDialog open onClose={() => undefined} onAdded={() => undefined} />);
    const dlg = screen.getByRole('dialog', { name: '添加成员' });
    for (const l of [/^基础模型（必填）/, /^角色/, /^系统提示词/, /^头像/]) expect(within(dlg).getByLabelText(l)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '添加' })).toBeDisabled();
    await waitFor(() => expect(dlg.querySelectorAll('#add-member-models option')).toHaveLength(2));
    fireEvent.change(within(dlg).getByLabelText(/^基础模型/), { target: { value: 'Kimi K2' } });
    expect(within(dlg).getByRole('button', { name: '添加' })).toBeEnabled();
  });

  it('提交带上四项；提交中锁住不重复；失败时填的都还在并说清原因', async () => {
    const posts: string[] = [];
    let release: () => void = () => undefined;
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        if (u === '/api/capabilities') return json({ items: [] });
        posts.push(String(init?.body));
        await new Promise<void>((r) => (release = r));
        return fail ? json({ error: { code: 'DUPLICATE_NAME', message: '已有同名成员（不区分大小写）' } }, 409) : json({ member: { id: 'k', name: 'Kimi K2' } }, 201);
      }),
    );
    const onAdded = vi.fn();
    render(<AddMemberDialog open onClose={() => undefined} onAdded={onAdded} />);
    const dlg = screen.getByRole('dialog', { name: '添加成员' });
    fireEvent.change(within(dlg).getByLabelText(/^基础模型/), { target: { value: 'Kimi K2' } });
    fireEvent.change(within(dlg).getByLabelText(/^角色/), { target: { value: '研究员' } });
    fireEvent.change(within(dlg).getByLabelText(/^系统提示词/), { target: { value: '只用中文回答。' } });
    fireEvent.change(within(dlg).getByLabelText(/^头像/), { target: { value: '🦊' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(within(dlg).getByRole('button', { name: '正在保存…' })).toBeDisabled();
    fireEvent.submit(dlg.querySelector('form')!);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toEqual({ name: 'Kimi K2', role: '研究员', systemPrompt: '只用中文回答。', avatar: '🦊' });
    release();
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('已有同名成员');
    expect(within(dlg).getByLabelText(/^角色/)).toHaveValue('研究员');
    expect(within(dlg).getByLabelText(/^头像/)).toHaveValue('🦊');
    fail = false;
    fireEvent.click(within(dlg).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    release();
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });
});
