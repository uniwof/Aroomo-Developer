import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Accept } from '@/pages/Accept';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('凭链接设密码 /console/accept', () => {
  it('两次不一致先拦；一致则带 token 调 /auth/accept 并提示已设好；失败显示固定中文', async () => {
    window.history.replaceState(null, '', '/console/accept?token=ari_abc');
    const ok = vi.fn(async () => new Response(JSON.stringify({ expiresAt: 'x', user: { id: '1', email: 'a@b.c', role: 'admin' } }), { status: 200 }));
    render(<Accept fetchImpl={ok as unknown as typeof fetch} />);
    const pw = screen.getByLabelText('新密码');
    expect(pw.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(pw, { target: { value: 'abcdefghij1' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'abcdefghij2' } });
    fireEvent.click(screen.getByRole('button', { name: '设置密码' }));
    expect((await screen.findByRole('alert')).textContent).toBe('两次输入的密码不一样');
    expect(ok).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'abcdefghij1' } });
    fireEvent.click(screen.getByRole('button', { name: '设置密码' }));
    await screen.findByText(/密码已设好/);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/accept');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'ari_abc', password: 'abcdefghij1' });
    expect((init.headers as Record<string, string>)['x-aroomo-request']).toBe('1');
    cleanup();
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'INVITE_INVALID', message: '<b>x</b>' } }), { status: 400 }));
    render(<Accept fetchImpl={bad as unknown as typeof fetch} />);
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'abcdefghij1' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'abcdefghij1' } });
    fireEvent.click(screen.getByRole('button', { name: '设置密码' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('设置失败：链接可能已用过或已过期，请重新获取'));
  });
});
