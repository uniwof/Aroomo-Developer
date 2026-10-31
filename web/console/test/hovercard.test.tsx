import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { HoverCard, cardLines } from '@/components/HoverCard';
import { MemberAvatar } from '@/components/brand';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('悬停卡与头像', () => {
  it('cardLines 只有 3 行，未知余量不编数字', () => {
    const l = cardLines({ name: 'Kimi', type: ['text'], status: '可用', remaining: { value: null, unit: null, source: '未知' } });
    expect(l).toHaveLength(3);
    expect(l[2]).toBe('余量：未知');
    expect(cardLines({ name: 'K', type: ['text'], status: '可用', remaining: { value: 12, unit: '次/天', source: '估算' } })[2]).toBe('余量：12 次/天（估算）');
  });
  it('聚焦即出现 3 行', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'Kimi', type: ['text'], status: '休眠', remaining: { value: null, unit: null, source: '未知' } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<HoverCard memberId="m1"><MemberAvatar name="Kimi" online={false} /></HoverCard>);
    await act(async () => { fireEvent.focus(screen.getByRole('img').parentElement!); await new Promise((r) => setTimeout(r, 0)); });
    const tip = await screen.findByRole('tooltip');
    expect(tip.querySelectorAll('span.block')).toHaveLength(3);
    expect(tip.textContent).toContain('状态：休眠');
  });
  it('头像：永久免费实线、试用虚线、状态图标、aria', () => {
    const { container } = render(<><MemberAvatar name="A" online used={5} limit={10} free="trial" status="cooldown" working /><MemberAvatar name="B" online free="permanent" /></>);
    const [a, b] = container.querySelectorAll('[role=img]');
    expect(a!.getAttribute('aria-label')).toContain('试用');
    expect(a!.getAttribute('aria-label')).toContain('额度已用 50%');
    expect(a!.querySelector('[data-testid=avatar-status]')!.textContent).toBe('⌛');
    expect(a!.querySelector('circle')!.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(b!.querySelector('circle')!.getAttribute('stroke-dasharray')).toBeNull();
    expect(b!.getAttribute('aria-label')).toContain('余量未知');
  });
});
