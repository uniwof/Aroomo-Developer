import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Members } from '@/pages/Members';
import { session } from '@/lib/api';
import { worstRow, type UsageRow } from '@/lib/usage';

afterEach(() => {
  cleanup();
  session.set(null);
  vi.unstubAllGlobals();
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const row = (o: Partial<UsageRow>): UsageRow => ({
  memberId: 'a', name: 'A', today: { requests: 0, errors: 0, limited: 0 }, last7DaysRequests: 0,
  quota: { used: 0, limit: null, unit: '次/天' }, quotaKnown: false, ratio: null, state: 'unknown', ...o,
});

describe('额度圆环', () => {
  it('没填上限=未知，取最满的一位', () => {
    expect(worstRow(null)).toBeNull();
    expect(worstRow([row({})])).toBeNull();
    const w = worstRow([row({ memberId: 'x', quotaKnown: true, quota: { used: 1, limit: 10, unit: '' }, ratio: 0.1 }), row({ memberId: 'y', quotaKnown: true, quota: { used: 9, limit: 10, unit: '' }, ratio: 0.9 })]);
    expect(w?.memberId).toBe('y');
  });
  it('成员行显示今天次数与「未知」上限', async () => {
    session.set('x');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/members')) return json({ members: [{ id: 'a', name: 'Groq', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }] });
      if (url.startsWith('/api/usage')) return json({ members: [row({ memberId: 'a', name: 'Groq', today: { requests: 4, errors: 0, limited: 0 }, quota: { used: 4, limit: null, unit: '次/天' } })] });
      return json({});
    }));
    render(<MemoryRouter><Members /></MemoryRouter>);
    expect(await screen.findByText(/今天 4 次/)).toBeInTheDocument();
    expect(screen.getByText(/每天上限 未知/)).toBeInTheDocument();
  });
});
