/**
 * X-06 分工的送达状态（docs/api/stream-parts.md §2）：成员那一步依次 已派出（pending）→ 已收到（received，网关接下了）
 * → 在做（running，第一个字到了）→ 已回复（done）。成员没反应时，任务卡能看出卡在哪一步。
 * 成员调用改成流式后，用量（token）照记。memory + PGlite（+ CI 真 PG）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantEnv, type AssistantEnv, LEAD, WORKER } from './helpers/assistants.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';
import { ChatService, usageTokensOf } from '../src/chat/service.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('usageTokensOf', () => {
  it('取 SSE 事件里的 usage.total_tokens；没有或不是正数 = 0', () => {
    expect(usageTokensOf('data: {"choices":[],"usage":{"total_tokens":7}}')).toBe(7);
    expect(usageTokensOf('data: {"choices":[{"delta":{"content":"usage"}}]}')).toBe(0);
    expect(usageTokensOf('data: {"usage":{"total_tokens":-1}}')).toBe(0);
    expect(usageTokensOf('data: [DONE]')).toBe(0);
  });
});

describe('流式成员调用的用量（负责人阶段 3 必改 1）', () => {
  const enc = new TextEncoder();
  const run = async (events: string[]) => {
    const recorded: Array<[string, number]> = [];
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const ev of events) c.enqueue(enc.encode(`data: ${ev}\n\n`));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch;
    const svc = new ChatService({
      litellmBaseUrl: 'http://x',
      litellmKey: 'placeholder-key',
      listMembers: async () => [{ id: 'm1', name: 'GPT', aliases: [], enabled: true, status: 'active' } as never],
      lead: { get: async () => ({ effectiveLeadId: 'm1' }) } as never,
      onTokens: (m, n) => recorded.push([m, n]),
      fetchImpl,
    });
    const r = await svc.complete({ model: 'GPT', stream: true, messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal);
    await new Response(r.stream).text();
    return recorded;
  };
  const delta = (s: string, total?: number) =>
    JSON.stringify({ choices: [{ index: 0, delta: { content: s } }], ...(total === undefined ? {} : { usage: { total_tokens: total } }) });

  it('多块都带（累计）用量：只取最后一块，流结束时记一次', async () => {
    expect(await run([delta('a', 5), delta('b', 9), delta('c', 12), JSON.stringify({ choices: [], usage: { total_tokens: 15 } })])).toEqual([['GPT', 15]]);
  });
  it('没有一块带用量：记 0', async () => {
    expect(await run([delta('a'), delta('b')])).toEqual([['GPT', 0]]);
  });
});

describe.each(twoAccountEnvs)('X-06 送达状态 [$name]', (env) => {
  let e: AssistantEnv;
  beforeAll(async () => {
    e = await assistantEnv(env);
  });
  afterAll(async () => {
    await e.closeAll();
  });

  const steps = async (id: string, runId: string) => (await e.owner('GET', `/api/assistants/${id}/runs/${runId}`)).json().run.steps as J[];
  const workerStep = async (id: string, runId: string) => (await steps(id, runId)).find((s) => s.memberId === WORKER.id && s.action === 'work');
  const waitFor = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return;
      await sleep(10);
    }
    throw new Error('等不到');
  };

  it('成员的模型接下了但还没回字：任务卡停在「已收到」；回字后「已回复」；事件按 已派出 → 已收到 → 在做 → 已回复 追加', async () => {
    const id = await e.create({ name: '送达', members: [LEAD.id, WORKER.id] });
    let release!: () => void;
    e.gw.firstTokenGate.set(WORKER.name, new Promise<void>((r) => (release = r)));
    try {
      const r = await e.owner('POST', `/api/assistants/${id}/runs`);
      expect([200, 202]).toContain(r.statusCode);
      const runId = r.json().run.id as string;
      await waitFor(async () => (await workerStep(id, runId))?.status === 'received');
      expect(await workerStep(id, runId)).toMatchObject({ status: 'received', detail: '去查 A 站' });
      release();
      await e.app.assistants.runner.idle();
      expect(await workerStep(id, runId)).toMatchObject({ status: 'done' });
      const events = (await e.deps.assistants.listSteps('owner', runId)).filter((s) => s.memberId === WORKER.id).map((s) => s.status);
      expect(events).toEqual(['pending', 'received', 'running', 'done']);
      // 组长那几步不经过 received
      const lead = (await e.deps.assistants.listSteps('owner', runId)).filter((s) => s.memberId === LEAD.id).map((s) => s.status);
      expect(lead).not.toContain('received');
    } finally {
      e.gw.firstTokenGate.clear();
    }
  });

  it('成员的 Key 无效（网关不接）：从「已派出」直接到「失败」，不经过已收到；成员调用都是流式并要用量，用量照记', async () => {
    const id = await e.create({ name: '送达失败', members: [LEAD.id, WORKER.id] });
    e.gw.failStatus.set(WORKER.name, 401);
    e.gw.streamOptions.length = 0;
    try {
      const r = await e.owner('POST', `/api/assistants/${id}/runs`);
      await e.app.assistants.runner.idle();
      const runId = r.json().run.id as string;
      const events = (await e.deps.assistants.listSteps('owner', runId)).filter((s) => s.memberId === WORKER.id).map((s) => s.status);
      expect(events).toEqual(['pending', 'failed']);
      expect((await e.owner('GET', `/api/assistants/${id}/runs/${runId}`)).json().run.status).toBe('succeeded');
      expect(e.gw.streamOptions.length).toBeGreaterThan(0);
      expect(e.gw.streamOptions.every((o) => JSON.stringify(o) === '{"include_usage":true}')).toBe(true);
      const rows = (await e.owner('GET', '/api/usage')).json().members as J[];
      expect(rows.find((m) => m.name === LEAD.name)?.tokensToday).toBeGreaterThan(0);
    } finally {
      e.gw.failStatus.clear();
    }
  });
});
