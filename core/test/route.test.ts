import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delegateFromHint, executeMentionPlan, route } from '../src/router/route.js';
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

describe('delegateFromHint', () => {
  it('生成交给负责人的 DelegatePlan，保留原正文', () => {
    const plan = delegateFromHint('帮我总结这篇文章', ctx);
    expect(plan).toEqual({
      mode: 'delegate',
      leadId: 'gemini',
      strategy: 'single',
      body: '帮我总结这篇文章',
      hints: [],
    });
  });
});

describe('executeMentionPlan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('调用超时视同故障，使用假时钟验证 120 秒超时', async () => {
    const call = vi.fn((id: string, _body: string, options?: { signal?: AbortSignal }) => {
      return new Promise<string>((resolve, reject) => {
        if (id === 'groq') {
          resolve('groq ok');
          return;
        }
        // gemini hangs
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('Aborted'));
        });
      });
    });

    const promise = executeMentionPlan(['groq', 'gemini'], '你好', call, (id) => id);

    // Fast-forward past 120,000ms timeout
    await vi.advanceTimersByTimeAsync(120_001);

    const res = await promise;
    expect(res[0]).toEqual({ memberId: 'groq', status: 'ok', text: 'groq ok' });
    expect(res[1]).toMatchObject({
      memberId: 'gemini',
      status: 'failed',
      hint: { text: 'gemini 暂时无法回答', actions: [{ id: 'delegate_to_lead', label: '交给负责人' }] },
    });
  });

  it('自定义超时配置生效', async () => {
    const call = vi.fn((_id: string, _body: string, options?: { signal?: AbortSignal }) => {
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('Aborted'));
        });
      });
    });

    const promise = executeMentionPlan(['groq'], '你好', call, (id) => id, { timeoutMs: 5000 });

    await vi.advanceTimersByTimeAsync(5001);

    const res = await promise;
    expect(res[0]).toMatchObject({
      memberId: 'groq',
      status: 'failed',
    });
  });

  it('外部 AbortSignal 触发时能正确取消', async () => {
    const controller = new AbortController();
    const call = vi.fn((_id: string, _body: string, options?: { signal?: AbortSignal }) => {
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('External abort'));
        });
      });
    });

    const promise = executeMentionPlan(['groq'], '你好', call, (id) => id, { signal: controller.signal });

    controller.abort();

    const res = await promise;
    expect(res[0]).toMatchObject({
      memberId: 'groq',
      status: 'failed',
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

    const promise = executeMentionPlan(['a', 'b', 'c'], 'x', call);
    await vi.advanceTimersByTimeAsync(20);
    await promise;

    expect(maxInFlight).toBe(3);
  });
});
