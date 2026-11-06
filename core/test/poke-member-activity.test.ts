/** Poke §5 成员状态（docs/api/design-poke-data-v1.md）：只从真实信号推出；跨账号不串。 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantRun } from '../src/assistants/types.js';
import { COOLDOWN_MS, memberActivity } from '../src/members/activity.js';
import type { Member } from '../src/members/types.js';
import { UsageService } from '../src/usage/service.js';
import { type AssistantEnv, assistantEnv, LEAD, WORKER } from './helpers/assistants.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

const now = new Date('2026-11-06T02:00:00Z');
const m = (over: Partial<Member> = {}): Member => ({
  id: 'a', name: 'A', aliases: [], capabilityTags: [], enabled: true, pinned: false, sortOrder: 0, status: 'active', modelCaps: null,
  deletedAt: null, createdAt: now, updatedAt: now, ...over,
});
const base = { online: true, workingSince: null, today: { requests: 0 }, limit: null, now };

describe('memberActivity（纯函数）', () => {
  it('按顺序取第一个成立的；不给百分比', () => {
    expect(memberActivity(m({ enabled: false }), base)).toEqual({ state: 'unknown', reason: '已停用' });
    expect(memberActivity(m({ status: 'candidate' }), base).state).toBe('unknown');
    const since = new Date(now.getTime() - 5000);
    expect(memberActivity(m(), { ...base, workingSince: since })).toMatchObject({ state: 'working', since: since.toISOString() });
    const limitedAt = new Date(now.getTime() - 60_000).toISOString();
    expect(memberActivity(m(), { ...base, today: { requests: 3, lastLimitedAt: limitedAt } })).toMatchObject({ state: 'cooldown', since: limitedAt });
    const old = new Date(now.getTime() - COOLDOWN_MS - 1).toISOString();
    expect(memberActivity(m(), { ...base, today: { requests: 3, lastLimitedAt: old } }).state).toBe('ready');
    expect(memberActivity(m(), { ...base, today: { requests: 5 }, limit: 5 }).state).toBe('depleted');
    expect(memberActivity(m(), { ...base, today: { requests: 4 }, limit: 5 })).toEqual({ state: 'ready' });
    expect(memberActivity(m(), { ...base, online: false })).toEqual({ state: 'unknown', reason: '没有可用的 Key' });
    // 账号用户不统计用量：有 Key 就是就绪，不会凭空出冷却 / 耗尽
    expect(memberActivity(m(), { ...base, today: null, limit: 1 })).toEqual({ state: 'ready' });
    for (const s of [base, { ...base, limit: 10, today: { requests: 9 } }]) expect(JSON.stringify(memberActivity(m(), s))).not.toMatch(/%|ratio|percent/);
  });
});

describe.each(twoAccountEnvs)('GET /api/members 的 activity（$name）', (env) => {
  let e: AssistantEnv;
  beforeEach(async () => {
    e = await assistantEnv(env);
  });
  afterEach(async () => {
    await e.closeAll();
  });

  const activityOf = async (id: string, who = e.owner) => {
    const r = await who('GET', '/api/members');
    expect(r.statusCode).toBe(200);
    return (r.json().members as Array<{ id: string; activity?: { state: string } }>).find((x) => x.id === id)?.activity;
  };

  it('在跑的助手步骤 → 工作中；运行结束后不再是；别的账号看不到', async () => {
    const id = await e.create();
    const run: AssistantRun = {
      id: randomUUID(), assistantId: id, userId: 'owner', trigger: 'manual', scheduledFor: null, idempotencyKey: null, requestedAt: e.clock.now(),
      startedAt: e.clock.now(), finishedAt: null, status: 'running', failureCode: null, summary: null, usageState: null, calls: 0, messageIds: [],
    };
    expect(await e.deps.assistants.insertRun('owner', run)).toBe('ok');
    await e.deps.assistants.appendStep('owner', { runId: run.id, userId: 'owner', stepNo: 1, memberId: WORKER.id, action: 'work', status: 'pending', detail: '', createdAt: e.clock.now() });
    expect((await activityOf(WORKER.id))?.state).not.toBe('working');
    await e.deps.assistants.appendStep('owner', { runId: run.id, userId: 'owner', stepNo: 1, memberId: WORKER.id, action: 'work', status: 'running', detail: '', createdAt: e.clock.now() });
    expect(await activityOf(WORKER.id)).toMatchObject({ state: 'working' });
    expect((await activityOf(LEAD.id))?.state).not.toBe('working');
    // 小号：自己的成员列表里不会因为所有者的运行出现「工作中」
    const xs = (await e.xiao('GET', '/api/members')).json().members as Array<{ activity?: { state: string } }>;
    expect(xs.every((x) => x.activity?.state !== 'working')).toBe(true);
    await e.deps.assistants.appendStep('owner', { runId: run.id, userId: 'owner', stepNo: 1, memberId: WORKER.id, action: 'work', status: 'done', detail: '', createdAt: e.clock.now() });
    expect((await activityOf(WORKER.id))?.state).not.toBe('working');
  });

  it('今天被限流 → 冷却；超过 10 分钟后回到原状态；上限到了 → 耗尽', async () => {
    // 和服务器共用同一份设置存储：等同于对话时供应商回了 429
    const usage = new UsageService(e.deps.settings, e.clock.now);
    usage.record(LEAD.name, 'limited');
    await usage.flush();
    expect(await activityOf(LEAD.id)).toMatchObject({ state: 'cooldown' });
    e.clock.advance(COOLDOWN_MS + 1000);
    expect((await activityOf(LEAD.id))?.state).not.toBe('cooldown');
    const set = await e.owner('PUT', `/api/usage/limits/${LEAD.id}`, { dailyLimit: 1 });
    expect(set.statusCode).toBe(200);
    expect(await activityOf(LEAD.id)).toMatchObject({ state: 'depleted', reason: '今天的次数已到你填的上限' });
  });
});
