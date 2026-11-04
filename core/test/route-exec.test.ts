import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMBER_TIMEOUT_MS, delegateFromHint, executeMentionPlan, route } from '../src/router/route.js';
import type { RoutableMember } from '../src/router/types.js';

const members: RoutableMember[] = [
  { id: 'groq', name: 'Groq', enabled: true },
  { id: 'gemini', name: 'Gemini', enabled: true },
  { id: 'poke', name: 'Poke', enabled: true, external: true },
];

describe('executeMentionPlan：超时与取消（假时钟）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('默认 120 秒超时：超时视同故障，给「X 暂时无法回答」+「交给负责人」，其他人不受影响', async () => {
    expect(DEFAULT_MEMBER_TIMEOUT_MS).toBe(120_000);
    const signals: Record<string, AbortSignal> = {};
    const call = (id: string, body: string, signal: AbortSignal) => {
      signals[id] = signal;
      if (id === 'gemini') return new Promise<string>(() => undefined); // 永不返回
      return new Promise<string>((r) => setTimeout(() => r(`${id}:${body}`), 1000));
    };
    const p = executeMentionPlan(['groq', 'gemini'], '你好', call, { nameOf: (id) => (id === 'gemini' ? 'Gemini' : id) });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signals.gemini?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res[0]).toEqual({ memberId: 'groq', status: 'ok', text: 'groq:你好' });
    expect(res[1]).toMatchObject({
      memberId: 'gemini',
      status: 'failed',
      reason: 'timeout',
      hint: { text: 'Gemini 暂时无法回答', memberId: 'gemini', body: '你好', actions: [{ id: 'delegate_to_lead', label: '交给负责人' }] },
    });
    expect(signals.gemini?.aborted).toBe(true);
    expect(signals.groq?.aborted).toBe(false);
  });

  it('超时可配置', async () => {
    const call = () => new Promise<string>((r) => setTimeout(() => r('late'), 5000));
    const p = executeMentionPlan(['groq'], 'x', call, { timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p)[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('外部取消：所有未完成的调用被中止', async () => {
    const ctrl = new AbortController();
    const seen: AbortSignal[] = [];
    const call = (_id: string, _b: string, s: AbortSignal) => {
      seen.push(s);
      return new Promise<string>(() => undefined);
    };
    const p = executeMentionPlan(['groq', 'gemini'], 'x', call, { signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    const res = await p;
    expect(res.map((r) => r.status === 'failed' && r.reason)).toEqual(['aborted', 'aborted']);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });

  it('call 同步抛错也只影响自己', async () => {
    const call = (id: string) => {
      if (id === 'groq') throw new Error('sync boom');
      return Promise.resolve('ok');
    };
    const res = await executeMentionPlan(['groq', 'gemini'], 'x', call);
    expect(res.map((r) => r.status)).toEqual(['failed', 'ok']);
  });
});

describe('delegateFromHint', () => {
  it('点「交给负责人」后生成单人完成的计划，保留原问题正文，不换成其他被点名成员', async () => {
    const res = await executeMentionPlan(['groq'], '帮我写周报\n要点：A、B', () => Promise.reject(new Error('down')));
    const hint = res[0]?.status === 'failed' ? res[0].hint : null;
    expect(hint).not.toBeNull();
    const plan = delegateFromHint(hint!, { members, leadId: 'gemini' });
    expect(plan).toEqual({ mode: 'delegate', leadId: 'gemini', strategy: 'single', body: '帮我写周报\n要点：A、B', hints: [] });
  });

  it('路由阶段的提示（停用 / 未知成员）也带原问题正文', () => {
    const p = route('@Nobody 帮忙总结', { members, leadId: 'gemini' });
    if (p.mode !== 'mention') throw new Error('unreachable');
    expect(delegateFromHint(p.hints[0]!, { members, leadId: 'gemini' }).body).toBe('帮忙总结');
  });

  it('没有正文或没有「交给负责人」动作的提示不能转交', () => {
    expect(() => delegateFromHint({ kind: 'hint', text: 'x', actions: [{ id: 'delegate_to_lead', label: '交给负责人' }] }, { members, leadId: 'gemini' })).toThrow();
    expect(() => delegateFromHint({ kind: 'hint', text: 'x', actions: [], body: 'b' }, { members, leadId: 'gemini' })).toThrow();
  });
});

describe('敏感项目（D38）', () => {
  it('不点名外部成员：给提示 +「交给负责人」，内置成员照常回答', () => {
    const p = route('@Poke @Groq 看看合同', { members, leadId: 'gemini', sensitive: true });
    if (p.mode !== 'mention') throw new Error('unreachable');
    expect(p.targets).toEqual(['groq']);
    expect(p.hints).toEqual([
      { kind: 'hint', text: '敏感项目不发给外部成员 Poke', memberId: 'poke', body: '看看合同', actions: [{ id: 'delegate_to_lead', label: '交给负责人' }] },
    ]);
  });

  it('非敏感项目可以点名外部成员', () => {
    const p = route('@Poke 看看', { members, leadId: 'gemini' });
    expect(p.mode === 'mention' && p.targets).toEqual(['poke']);
  });

  it('外部智能体负责人不能接手敏感任务（无 @ 与「交给负责人」两条路都拦住）', () => {
    const p = route('看看合同', { members, leadId: 'poke', sensitive: true });
    expect(p).toMatchObject({ mode: 'delegate', leadId: null, strategy: 'single' });
    expect(p.hints[0]?.actions).toEqual([]);
    const plan = delegateFromHint({ kind: 'hint', text: 't', body: '看看合同', actions: [{ id: 'delegate_to_lead', label: '交给负责人' }] }, { members, leadId: 'poke', sensitive: true });
    expect(plan.leadId).toBeNull();
  });

  it('敏感项目交给内置负责人：只用单人完成', () => {
    expect(route('看看合同', { members, leadId: 'gemini', sensitive: true })).toEqual({ mode: 'delegate', leadId: 'gemini', strategy: 'single', body: '看看合同', hints: [] });
  });
});
