/** 助手测试基建：两账号 + 假模型网关（按提示词回分工 JSON / 成员结果 / 汇总）+ 所有者名下三位成员。 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { CoreDeps } from '../../src/deps.js';
import { LiteLLMAdmin } from '../../src/keys/litellm.js';
import { MOCK_MASTER_KEY, type MockLiteLLM, startMockLiteLLM } from './mock-litellm.js';
import { type DepsEnv, twoAccounts, type TwoAccounts } from './two-accounts.js';

/** 成员名 = Key 的对外名；model 是 Key 的真实模型串（isFreeModel 按它判断）：两位种子清单里的免费模型 + 一个付费的 */
export const LEAD = { name: 'gpt-oss-120b', id: 'gpt-oss-120b', model: 'groq/gpt-oss-120b' };
export const WORKER = { name: 'qwen3.8-27b', id: 'qwen3-8-27b', model: 'groq/qwen3.8-27b' };
export const PAID = { name: 'PaidBot', id: 'paidbot', model: 'openai/gpt-5' };

/** 直接在 Key 存储里记一个部署（不经确认流程；只给测试用） */
export async function addDeployment(t: Pick<TwoAccounts, 'deps' | 'clock'>, modelName: string, model: string, userId?: string): Promise<void> {
  const now = t.clock.now();
  await t.deps.keys.insert({
    id: randomUUID(), ...(userId ? { userId } : {}), name: `key-${modelName}`, sourceUrl: 'https://example.test', last4: '0000', model, modelName,
    apiBase: null, litellmModelId: `aroomo-${randomUUID()}`, status: 'active', modelsSyncedAt: null, createdAt: now, updatedAt: now,
  });
}

export interface FakeGateway {
  /** 每次上游调用的模型名 */
  calls: string[];
  /** 这些模型一直不回，直到中断 */
  slow: Set<string>;
  /** 这些模型返回这个 HTTP 状态 */
  failStatus: Map<string, number>;
  /** 设了就先等它再回（测试用来让几次运行同时卡在调用上） */
  gate: Promise<void> | null;
}

export interface AssistantEnv extends TwoAccounts {
  gw: FakeGateway;
  mock: MockLiteLLM;
  /** 所有者建一个助手，返回 id */
  create(body?: Record<string, unknown>, headers?: Record<string, string>): Promise<string>;
  closeAll(): Promise<void>;
}

export const baseBody = (over: Record<string, unknown> = {}) => ({
  name: '资源周报',
  instructions: '每周找全网新的免费模型，筛好了告诉我',
  members: [LEAD.id, WORKER.id],
  schedule: { kind: 'weekly', time: '09:00', days: [1] },
  ...over,
});

export async function assistantEnv(
  env: DepsEnv,
  opts: { timeoutMs?: number; extraEnv?: Record<string, string>; budgets?: CoreDeps['assistantBudgets'] } = {},
): Promise<AssistantEnv> {
  const mock = await startMockLiteLLM();
  const gw: FakeGateway = { calls: [], slow: new Set(), failStatus: new Map(), gate: null };
  const t = await twoAccounts(
    {
      name: env.name,
      make: async (now) => {
        const deps = await env.make(now);
        deps.litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY, timeoutMs: 2000 });
        if (opts.timeoutMs !== undefined) deps.assistantTimeoutMs = () => opts.timeoutMs!;
        if (opts.budgets) deps.assistantBudgets = opts.budgets;
        deps.chatFetch = (async (_u: unknown, init?: { body?: string; signal?: AbortSignal }) => {
          const b = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
          gw.calls.push(b.model);
          if (gw.gate) await gw.gate;
          if (gw.slow.has(b.model)) {
            await new Promise<void>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
          }
          const st = gw.failStatus.get(b.model);
          if (st) return new Response('{}', { status: st });
          const prompt = b.messages.at(-1)?.content ?? '';
          const content = prompt.includes('只回 JSON')
            ? `好的：{"tasks":[{"member":"${WORKER.name}","task":"去查 A 站"},{"member":"${PAID.name}","task":"去查 B 站"}]}`
            : prompt.includes('成员的结果如下')
              ? '汇总完成：找到 3 条'
              : `结果-${b.model}\n<tool_call>{"x":1}</tool_call>`;
          return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
        }) as typeof fetch;
        return deps;
      },
    },
    { LITELLM_BASE_URL: mock.url, LITELLM_MASTER_KEY: MOCK_MASTER_KEY, ...(opts.extraEnv ?? {}) },
  );
  for (const m of [LEAD, WORKER, PAID]) {
    const r = await t.owner('POST', '/api/members', { name: m.name });
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect(r.json().member.id).toBe(m.id);
    await addDeployment(t, m.name, m.model);
  }
  return {
    ...t,
    gw,
    mock,
    async create(body = {}, headers) {
      const r = await t.owner('POST', '/api/assistants', baseBody(body), headers);
      expect(r.statusCode, r.body).toBe(201);
      return r.json().assistant.id as string;
    },
    async closeAll() {
      await t.app.assistants.runner.shutdown();
      await t.close();
      await mock.close();
    },
  };
}
