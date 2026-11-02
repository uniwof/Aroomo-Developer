import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Inbox } from '@/pages/Inbox';
import { session } from '@/lib/api';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const challenge = (nextStep: number, notBefore: string | null) => ({
  id: 'c1', level: 'important', kind: 'irreversible', title: '彻底删除成员「Groq」', consequences: ['删除后找不回来'], confirmLabel: '彻底删除',
  nextStep, minDelayMs: 3000, step2NotBefore: notBefore, requiresAccessReauth: false, expiresAt: '2099-01-01T00:00:00Z', stepUrl: '/api/confirm/c1/steps',
});

describe('确认卡', () => {
  it('收件箱重要动作：428 → 继续 → 确认 → 带令牌重发', async () => {
    session.set('x');
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/tasks')) return json(404, {});
        if (url.startsWith('/api/inbox?')) {
          return json(200, { groups: { decision: [{ id: 'i1', group: 'decision', title: '删成员？', createdAt: 'x', actions: [{ id: 'purge', label: '彻底删除', confirm: { kind: 'irreversible' } }] }], candidate: [], brief: [] } });
        }
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        posts.push({ url, body });
        if (url === '/api/inbox/i1/actions/purge') return body?.confirmToken ? json(200, { item: {} }) : json(428, { error: { code: 'CONFIRM_REQUIRED', message: 'x', confirm: challenge(1, null) } });
        if (url === '/api/confirm/c1/steps' && body.step === 1) return json(200, { confirm: challenge(2, '2000-01-01T00:00:00Z') });
        if (url === '/api/confirm/c1/steps') return json(200, { confirm: challenge(0, null), confirmToken: 'tok' });
        return json(404, {});
      }),
    );
    render(<Inbox />);
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }));
    expect(await screen.findByText('删除后找不回来')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    const card = await screen.findByRole('alertdialog');
    fireEvent.click(await within(card).findByRole('button', { name: '彻底删除' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/inbox/i1/actions/purge', body: { confirmToken: 'tok' } }));
  });
});
