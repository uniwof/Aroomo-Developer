/**
 * 阶段 2 预审（Gemini）助手部分的修复，每条先写失败用例：
 * 1. 付费判断按 Key 的真实模型串（能力种子清单），成员名 / Key 对外名起成免费模型的名字也绕不过确认；
 * 2. 同意只对卡上那组成员和模型有效，等确认期间成员组变了 → 同意作废、重新确认；
 * 3. 每天调用上限在并发运行下也守得住（每次调用前在库里原子占名额）；
 * 5. 建助手和开场白在同一个事务里。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAssistantStore } from '../src/assistants/memory.js';
import { PgAssistantStore } from '../src/assistants/pg.js';
import type { Assistant, AssistantStore, ConversationMessage } from '../src/assistants/types.js';
import { confirmOverHttp } from './helpers/confirm.js';
import { addDeployment, assistantEnv, type AssistantEnv, LEAD, PAID, WORKER } from './helpers/assistants.js';
import { dbTargets, ownerAuth } from './helpers/db.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.each(twoAccountEnvs)('助手预审：付费判断与确认绑定 [$name]', (env) => {
  let e: AssistantEnv;
  beforeAll(async () => {
    e = await assistantEnv(env);
    // 名字像种子清单里的免费模型，Key 背后却是付费模型
    await addDeployment(e, 'gpt-oss-20b', 'openai/gpt-5');
    expect((await e.owner('POST', '/api/members', { name: 'gpt-oss-20b' })).statusCode).toBeLessThan(300);
    await addDeployment(e, 'PaidTwo', 'anthropic/claude-opus-5');
    expect((await e.owner('POST', '/api/members', { name: 'PaidTwo' })).statusCode).toBeLessThan(300);
  });
  afterAll(async () => {
    await e.closeAll();
  });

  const start = async (id: string) => {
    const r = await e.owner('POST', `/api/assistants/${id}/runs`);
    expect([200, 202], r.body).toContain(r.statusCode);
    await e.app.assistants.runner.idle();
    return (await e.owner('GET', `/api/assistants/${id}/runs/${r.json().run.id}`)).json().run as J;
  };
  const cardFor = async (runId: string) => {
    const g = (await e.owner('GET', '/api/inbox')).json().groups as Record<string, J[]>;
    return Object.values(g).flat().filter((i) => i.related?.id === runId && i.kind === 'assistant.run.confirm');
  };
  const approve = async (cardId: string) => {
    const ok = await confirmOverHttp(e.app, e.clock, ownerAuth, (token) => e.owner('POST', `/api/inbox/${cardId}/actions/approve`, token ? { confirmToken: token } : undefined));
    expect(ok.statusCode, ok.body).toBe(200);
    await e.app.assistants.runner.idle();
  };

  it('1. 成员名起成免费模型的名字（Key 实际是付费模型）：低额度 → failed/budget 一次不调；中额度 → 先等确认', async () => {
    const low = await e.create({ name: '假免费-低', members: ['gpt-oss-20b'] });
    e.gw.calls.length = 0;
    expect(await start(low)).toMatchObject({ status: 'failed', failureCode: 'budget' });
    expect(e.gw.calls).toEqual([]);

    const mid = await e.create({ name: '假免费-中', members: ['gpt-oss-20b'], budgetLevel: 'mid' });
    expect((await start(mid)).status).toBe('waiting_confirmation');
    expect(e.gw.calls).toEqual([]);
  });

  it('1. 运行中途免费成员被改名成付费 Key 的对外名：不拿开始时的判断去调付费模型（failed/no_member）', async () => {
    await addDeployment(e, 'Renamed', 'openai/gpt-5');
    const id = await e.create({ name: '中途改名', members: [LEAD.id, WORKER.id] });
    let release!: () => void;
    e.gw.gate = new Promise<void>((r) => (release = r));
    e.gw.calls.length = 0;
    const r = await e.owner('POST', `/api/assistants/${id}/runs`);
    const runId = r.json().run.id as string;
    // 组长分工那次调用卡住时改名，放行后轮到成员
    for (let i = 0; i < 400 && e.gw.calls.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
    try {
      expect((await e.owner('PATCH', `/api/members/${WORKER.id}`, { name: 'Renamed' })).statusCode).toBeLessThan(300);
    } finally {
      e.gw.gate = null;
      release();
    }
    await e.app.assistants.runner.idle();
    expect((await e.owner('GET', `/api/assistants/${id}/runs/${runId}`)).json().run).toMatchObject({ status: 'failed', failureCode: 'no_member' });
    expect(e.gw.calls).not.toContain('Renamed');
    expect((await e.owner('PATCH', `/api/members/${WORKER.id}`, { name: WORKER.name })).statusCode).toBeLessThan(300);
  });

  it('2. 等确认期间加了一位付费成员：之前的同意作废 → 回到 waiting_confirmation，发新卡；新加的付费成员一次没调', async () => {
    const id = await e.create({ name: '换人', members: [LEAD.id, PAID.id], budgetLevel: 'mid' });
    e.gw.calls.length = 0;
    const r = await start(id);
    expect(r.status).toBe('waiting_confirmation');
    const [card] = await cardFor(r.id);
    expect((await e.owner('PATCH', `/api/assistants/${id}`, { members: [LEAD.id, PAID.id, 'paidtwo'] })).statusCode).toBe(200);
    await approve(card!.id);
    const after = (await e.owner('GET', `/api/assistants/${id}/runs/${r.id}`)).json().run as J;
    expect(after.status).toBe('waiting_confirmation');
    expect(e.gw.calls).not.toContain('PaidTwo');
    expect(e.gw.calls).not.toContain(PAID.name);
    const cards = await cardFor(r.id);
    expect(cards.length).toBe(2);
    expect(cards.some((c) => /PaidTwo/.test(c.summary))).toBe(true);
    // 指纹不出现在界面的步骤里
    expect((after.steps as J[]).every((s) => !/\[set:/.test(s.detail))).toBe(true);
    // 对新卡同意 → 这次才真的跑
    await approve(cards.find((c) => /PaidTwo/.test(c.summary))!.id);
    expect((await e.owner('GET', `/api/assistants/${id}/runs/${r.id}`)).json().run.status).toBe('succeeded');
    expect(e.gw.calls).toContain('PaidTwo');
  });
});

describe.each(twoAccountEnvs)('助手预审：每天上限在并发运行下守得住 [$name]', (env) => {
  it('3. 两个助手同时跑（每次上限 3、每天上限 4）：合计调用不超过 4', async () => {
    const budgets = { low: { perRun: 3, perDay: 4 }, mid: { perRun: 3, perDay: 4 }, high: { perRun: 3, perDay: 4 } };
    const e = await assistantEnv(env, { budgets });
    try {
      const a = await e.create({ name: '并发 A', members: [LEAD.id, WORKER.id] });
      const b = await e.create({ name: '并发 B', members: [LEAD.id, WORKER.id] });
      let release!: () => void;
      e.gw.gate = new Promise<void>((r) => (release = r));
      e.gw.calls.length = 0;
      const ra = await e.owner('POST', `/api/assistants/${a}/runs`);
      const rb = await e.owner('POST', `/api/assistants/${b}/runs`);
      // 两次运行都已经发出第一次调用（都读过「今天用了多少」）再放行
      for (let i = 0; i < 400 && e.gw.calls.length < 2; i++) await new Promise((x) => setTimeout(x, 5));
      expect(e.gw.calls.length).toBe(2);
      release();
      e.gw.gate = null;
      await e.app.assistants.runner.idle();
      const runs = await Promise.all([[a, ra], [b, rb]].map(async ([id, r]) => (await e.owner('GET', `/api/assistants/${id}/runs/${(r as J).json().run.id}`)).json().run as J));
      expect(e.gw.calls.length).toBeLessThanOrEqual(4);
      const stored = await Promise.all([a, b].map(async (id) => (await e.deps.assistants.listRuns('owner', id as string, 1))[0]!.calls));
      expect(stored.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(4);
      // 谁先占到名额不确定：至少有一次因为每天上限停下（failed/budget），没有一次超额
      expect(runs.some((r) => r.status === 'failed' && r.failureCode === 'budget')).toBe(true);
    } finally {
      e.gw.gate = null;
      await e.closeAll();
    }
  });
});

describe('助手预审：建助手和开场白在同一个事务里', () => {
  const T0 = new Date('2026-11-05T11:00:00Z');
  const fixture = (userId: string) => {
    const a: Assistant = {
      id: randomUUID(), userId, name: 'A', instructions: '0123456789', leadMemberId: 'm-1', members: [{ memberId: 'm-1', role: 'lead', position: 0 }],
      enabled: true, schedule: { kind: 'manual' }, timezone: 'Asia/Shanghai', catchUp: 'skip', maxRuntimeSec: 600, budgetLevel: 'low', notify: true,
      conversationId: randomUUID(), nextRunAt: null, pausedAt: null, idempotencyKey: null, idempotencyHash: null, createdAt: T0, updatedAt: T0,
    };
    const conv = { id: a.conversationId, userId, kind: 'assistant' as const, title: 'A', memberIds: ['m-1'], readAt: null, createdAt: T0, updatedAt: T0 };
    return { a, conv };
  };
  const stores: Array<{ name: string; open: () => Promise<{ store: AssistantStore; close: () => Promise<void> }> }> = [
    { name: 'memory', open: async () => ({ store: new MemoryAssistantStore(), close: async () => undefined }) },
    ...dbTargets.map((t) => ({
      name: t.name,
      open: async () => {
        const db = await t.open();
        await db.query(`SELECT set_config('app.user_id', 'owner', false)`);
        await db.query(`INSERT INTO members (id, user_id, name, created_at, updated_at) VALUES ('m-1', 'owner', 'M', now(), now())`);
        await db.query(`SELECT set_config('app.user_id', '', false)`);
        return { store: new PgAssistantStore(db) as AssistantStore, close: () => db.close() };
      },
    })),
  ];
  it.each(stores)('5. 开场白写不进去 → 助手和会话都不留 [$name]', async ({ open }) => {
    const { store, close } = await open();
    try {
      const { a, conv } = fixture('owner');
      // 写不进去的开场白：PG 违反角色检查，内存版指向别的会话
      const bad = { id: randomUUID(), conversationId: randomUUID(), userId: 'owner', role: 'bogus', memberId: 'm-1', runId: null, content: 'x', createdAt: T0 } as unknown as ConversationMessage;
      await expect(store.createAssistant('owner', a, conv, bad)).rejects.toThrow();
      expect(await store.countAssistants('owner')).toBe(0);
      expect(await store.getAssistant('owner', a.id)).toBeNull();
      // 正常的开场白：一起写进去
      const ok: ConversationMessage = { id: randomUUID(), conversationId: conv.id, userId: 'owner', role: 'member', memberId: 'm-1', runId: null, content: '我是 A', createdAt: T0 };
      expect(await store.createAssistant('owner', a, conv, ok)).toBe('ok');
      expect((await store.listMessages('owner', conv.id, 10)).map((m) => m.content)).toEqual(['我是 A']);
    } finally {
      await close();
    }
  });
});

describe('助手：出错时的失败码', () => {
  it('数据库错误自带的 code（如 23505）不当失败码 → upstream_error；已知的码照用', async () => {
    const { _forTests } = await import('../src/assistants/runner.js');
    expect(_forTests.failureCodeOf(Object.assign(new Error('dup'), { code: '23505' }))).toBe('upstream_error');
    expect(_forTests.failureCodeOf(new Error('x'))).toBe('upstream_error');
    expect(_forTests.failureCodeOf(null)).toBe('upstream_error');
    expect(_forTests.failureCodeOf({ code: 'timeout' })).toBe('timeout');
  });
});
