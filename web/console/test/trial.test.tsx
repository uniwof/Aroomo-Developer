import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CapabilityMap } from '../src/components/CapabilityMap';
import { trialText } from '../src/lib/capabilities';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('试用到期', () => {
  it('文字', () => {
    expect(trialText({ access: 'free' })).toBeNull();
    expect(trialText({ access: 'trial' })).toBe('到期日未填');
    expect(trialText({ access: 'trial', trialEndsAt: '2026-11-02', trialDaysLeft: 3 })).toBe('试用还剩 3 天（2026-11-02）');
    expect(trialText({ access: 'trial', trialEndsAt: '2026-10-29', trialDaysLeft: -1 })).toContain('已过期 1 天');
  });

  it('临近到期提示 + 填到期日', async () => {
    const items = [
      { id: 'a', name: '模型A', kind: 'text', provider: 'P', access: 'trial', quota: null, trialEndsAt: '2026-11-01', trialDaysLeft: 2 },
      { id: 'b', name: '模型B', kind: 'image', provider: 'P', access: 'trial', quota: null, trialEndsAt: null, trialDaysLeft: null },
    ];
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? new Response(JSON.stringify({ id: 'b', trialEndsAt: '2026-12-01', trialDaysLeft: 31 }), { status: 200 })
        : new Response(JSON.stringify({ items }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CapabilityMap />);
    await screen.findByTestId('trial-soon');
    expect(screen.getByTestId('trial-soon').textContent).toContain('还剩 2 天');
    fireEvent.click(screen.getByText('填到期日'));
    fireEvent.change(screen.getByLabelText('模型B 的试用到期日'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByTestId('trial-b').textContent).toContain('还剩 31 天'));
  });
});
