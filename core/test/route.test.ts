import { describe, expect, it, vi } from 'vitest';
import { executeMentionPlan, route } from '../src/router/route.js';
import type { RoutableMember } from '../src/router/types.js';

const members: RoutableMember[] = [
  { id: 'groq', name: 'Groq', enabled: true },
  { id: 'gemini', name: 'Gemini', enabled: true },
  { id: 'old', name: 'OldBot', enabled: false },
];
const ctx = { members, leadId: 'gemini' };

describe('route', () => {
  it('没有 @ → 交给负责人，P0 只用单人完成', () => {
    expect(route('总结一下今天的新闻', ctx)).toEqual({
      mode: 'delegate',
      leadId: 'gemini',
      strategy: 'single',
      body: '总结一下今天的新闻',
      hints: [],
    });
  });

  it('没有负责人时 leadId 为 null，由调用方提示', () => {
    const p = route('你好', { members, leadId: null });
    expect(p.mode).toBe('delegate');
    expect(p.mode === 'delegate' && p.leadId).toBeNull();
  });

  it('@ 一个成员 → 点名，负责人不介入', () => {
    const p = route('@Groq 你好', ctx);
    expect(p).toMatchObject({ mode: 'mention', targets: ['groq'], body: '你好', hints: [] });
  });

  it('@ 多个成员 → 各自独立回答', () => {
    const p = route('@Groq @Gemini 各写一句诗', ctx);
    expect(p.mode).toBe('mention');
    expect(p.mode === 'mention' && p.targets).toEqual(['groq', 'gemini']);
  });

  it('@ 停用成员或未知名字 → 一行提示 +「交给负责人」，不自动换人', () => {
    const p = route('@OldBot @Nobody 在吗', ctx);
    expect(p.mode).toBe('mention');
    if (p.mode !== 'mention') return;
    expect(p.targets).toEqual([]);
    expect(p.hints.map((h) => h.text)).toEqual(['OldBot 已停用，暂时不能回答', '没有叫「Nobody」的成员']);
    for (const h of p.hints) expect(h.actions).toEqual([{ id: 'delegate_to_lead', label: '交给负责人' }]);
  });
});

describe('executeMentionPlan', () => {
  it('并行调用，失败的只给提示，不影响其他人、不换人', async () => {
    const call = vi.fn(async (id: string, body: string) => {
      if (id === 'gemini') throw new Error('429');
      return `${id}:${body}`;
    });
    const res = await executeMentionPlan(['groq', 'gemini'], '你好', call, (id) =>
      id === 'gemini' ? 'Gemini' : id,
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(res[0]).toEqual({ memberId: 'groq', status: 'ok', text: 'groq:你好' });
    expect(res[1]).toMatchObject({
      memberId: 'gemini',
      status: 'failed',
      hint: { text: 'Gemini 暂时无法回答', actions: [{ id: 'delegate_to_lead', label: '交给负责人' }] },
    });
  });

  it('调用确实是并行发出的', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const call = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return 'ok';
    };
    await executeMentionPlan(['a', 'b', 'c'], 'x', call);
    expect(maxInFlight).toBe(3);
  });
});
