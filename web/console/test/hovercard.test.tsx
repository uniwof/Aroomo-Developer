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
    const { container } = render(<><MemberAvatar name="A" online used={5} limit={10} free="trial" status="trial" /><MemberAvatar name="B" online used={0} limit={10} free="permanent" /></>);
    const [a, b] = container.querySelectorAll('[role=img]');
    expect(a!.getAttribute('aria-label')).toContain('试用');
    expect(a!.getAttribute('aria-label')).toContain('额度剩余 50%');
    expect(a!.querySelector('[data-testid=avatar-status]')!.textContent).toBe('⌛');
    expect(a!.querySelector('circle')!.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(b!.querySelector('circle')!.getAttribute('stroke-dasharray')).toBeNull();
  });
});

describe('#383 余量未知的圆环', () => {
  it('未知走「未知」分支（灰色虚线整圈），0% 与 100% 不走；aria 写「余量未知」', () => {
    const { container } = render(<><MemberAvatar name="U" online /><MemberAvatar name="Z" online used={0} limit={10} /><MemberAvatar name="F" online used={10} limit={10} /></>);
    const [u, z, f] = container.querySelectorAll('[role=img]');
    const ring = u!.querySelector('[data-testid=avatar-ring-unknown]')!;
    expect(ring.getAttribute('stroke')).toBe('var(--muted)');
    expect(ring.getAttribute('stroke-dasharray')).toBe('2 4');
    expect(u!.querySelector('[data-testid=avatar-arc]')).toBeNull();
    expect(u!.getAttribute('aria-label')).toContain('余量未知');
    for (const el of [z!, f!]) {
      expect(el.querySelector('[data-testid=avatar-ring-unknown]')).toBeNull();
      expect(el.getAttribute('aria-label')).not.toContain('余量未知');
    }
    expect(z!.getAttribute('aria-label')).toContain('额度剩余 100%');
    expect(f!.getAttribute('aria-label')).toContain('额度剩余 0%');
  });
  it('cardLines 传了 status 就用它（行内同源），不传才用 Core 的', () => {
    const c = { name: 'K', type: ['text'], status: '可用', remaining: { value: null, unit: null, source: '未知' } };
    expect(cardLines(c, '不可用 · 没有可用的 Key')[1]).toBe('状态：不可用 · 没有可用的 Key');
    expect(cardLines(c)[1]).toBe('状态：可用');
  });
});

describe('#172 成员列表接入头像圆环 + 悬停卡', () => {
  it('wrap：不多占 Tab 位；按钮聚焦即出卡，读屏经 aria-describedby 读到 3 行；没有限速/价格/Key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'Kimi', type: ['text'], status: '可用', remaining: { value: 7, unit: '次/天', source: '估算' } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { container } = render(<HoverCard memberId="m1" wrap><button type="button" aria-describedby="hc-m1">Kimi</button></HoverCard>);
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(0);
    await act(async () => { screen.getByRole('button').focus(); await new Promise((r) => setTimeout(r, 0)); });
    const tip = await screen.findByRole('tooltip');
    await screen.findByText('余量：7 次/天（估算）');
    expect(tip.id).toBe('hc-m1');
    expect(tip.querySelectorAll('span.block')).toHaveLength(3);
    expect(tip.textContent).not.toMatch(/限速|价格|渠道|sk-|key/i);
  });
  it('读不到时说一句，不编数字', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })));
    render(<HoverCard memberId="m2" wrap><button type="button">X</button></HoverCard>);
    await act(async () => { screen.getByRole('button').focus(); await new Promise((r) => setTimeout(r, 0)); });
    expect(await screen.findByText('暂时读不到，稍后再看')).toBeTruthy();
  });
  it('长按出卡后松手，不触发按钮点击', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const onClick = vi.fn();
    render(<HoverCard memberId="m3" wrap><button type="button" onClick={onClick}>X</button></HoverCard>);
    const btn = screen.getByRole('button');
    fireEvent.touchStart(btn);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.touchEnd(btn);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('头像可包住传入的头像；圆环画剩余；停用降饱和带 ⏸', () => {
    const { container } = render(
      <MemberAvatar name="Kimi" online={false} status="paused" used={3} limit={4}>
        <span data-testid="face" />
      </MemberAvatar>,
    );
    const img = container.querySelector('[role=img]')!;
    expect(img.querySelector('[data-testid=face]')).toBeTruthy();
    expect(img.className).toContain('grayscale');
    expect(img.getAttribute('aria-label')).toContain('已停用');
    expect(img.getAttribute('aria-label')).toContain('额度剩余 25%');
    expect(img.querySelector('[data-testid=avatar-status]')!.textContent).toBe('⏸');
  });
  it('候选（离线、无角标）不读成「可用」', () => {
    const { container } = render(<MemberAvatar name="C" online={false} status="available" />);
    const label = container.querySelector('[role=img]')!.getAttribute('aria-label')!;
    expect(label).toContain('离线');
    expect(label).not.toContain('可用');
  });
});

describe('#172 MembersPanel', () => {
  it('每行头像带圆环，按钮指向自己的悬停卡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ members: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { MembersPanel } = await import('@/chat/panels');
    const m = { id: 'k1', name: 'Kimi', aliases: [], capabilityTags: ['text'], enabled: true, pinned: false, status: 'active', leadEligible: false };
    render(<MembersPanel members={[m]} onOpen={() => {}} />);
    const btn = screen.getByRole('button', { name: /Kimi/ });
    expect(btn.getAttribute('aria-describedby')).toBe('hc-k1');
    expect(btn.querySelector('[role=img]')!.getAttribute('aria-label')).toContain('余量未知');
  });
});
