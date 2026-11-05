/**
 * 助手定时执行器（默认关）与存储层隔离：总开关关着不注册；不重复、不并发、错过最多补一次；
 * 两个账号的助手在应用角色（受 RLS 约束）下互相看不到、也触发不了。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PgAssistantStore } from '../src/assistants/pg.js';
import { startOfDay } from '../src/assistants/runner.js';
import type { Assistant, AssistantRun, AssistantStore } from '../src/assistants/types.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { memoryDeps } from '../src/deps.js';
import { schedulerTick, SCHEDULER_JOB } from '../src/scheduler/assistant-scheduler.js';
import { buildServer } from '../src/server.js';
import { assistantEnv, LEAD } from './helpers/assistants.js';
import { OWNER_TOKEN } from './helpers/db.js';
import { rlsTargets } from './helpers/rls.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

describe('总开关 ASSISTANT_SCHEDULER_ENABLED', () => {
  const base = { CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN };
  it('默认关：配置为 false，定时任务里没有助手执行器', async () => {
    expect(loadConfig(base).assistantSchedulerEnabled).toBe(false);
    expect(loadConfig({ ...base, ASSISTANT_SCHEDULER_ENABLED: 'yes' }).assistantSchedulerEnabled).toBe(false);
    const app = buildServer(loadConfig(base), memoryDeps());
    expect(app.jobs.names()).not.toContain(SCHEDULER_JOB);
    await app.close();
  });
  it('设成 true 才注册', async () => {
    const app = buildServer(loadConfig({ ...base, ASSISTANT_SCHEDULER_ENABLED: 'true' }), memoryDeps());
    expect(app.jobs.names()).toContain(SCHEDULER_JOB);
    await app.close();
  });
});

describe.each(twoAccountEnvs)('定时执行器 schedulerTick [$name]', (env) => {
  const HOUR = 3_600_000;
  const setup = async (schedule: Record<string, unknown>, catchUp: 'skip' | 'latest' = 'skip') => {
    const e = await assistantEnv(env);
    const id = await e.create({ name: `定时-${randomUUID().slice(0, 4)}`, members: [LEAD.id], schedule, catchUp });
    const store = e.deps.assistants;
    const started: string[] = [];
    const tick = () => schedulerTick({ store, start: (_u, r) => started.push(r), now: e.clock.now });
    const a = async () => (await store.getAssistant('owner', id))!;
    const runs = async () => store.listRuns('owner', id, 100);
    return { e, id, store, started, tick, a, runs };
  };

  it('到点只开始一次：同一时刻再扫不重复，下次时间往后推；两次扫描同时进来也只开始一次', async () => {
    const s = await setup({ kind: 'interval', everyHours: 1 });
    try {
      const due = (await s.a()).nextRunAt!;
      s.e.clock.set(due.toISOString());
      const [r1, r2] = await Promise.all([s.tick(), s.tick()]);
      expect(r1.started + r2.started).toBe(1);
      expect(await s.tick()).toEqual({ started: 0, skipped: 0 });
      const runs = await s.runs();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'queued' });
      expect(runs[0]!.scheduledFor!.getTime()).toBe(due.getTime());
      expect((await s.a()).nextRunAt!.getTime()).toBe(due.getTime() + HOUR);
    } finally {
      await s.e.closeAll();
    }
  });

  it('同一个助手不并发：上一次还在跑，这一次记 skipped', async () => {
    const s = await setup({ kind: 'interval', everyHours: 1 });
    try {
      s.e.clock.set((await s.a()).nextRunAt!.toISOString());
      expect((await s.tick()).started).toBe(1); // 留着 queued，不执行
      s.e.clock.set((await s.a()).nextRunAt!.toISOString());
      expect(await s.tick()).toEqual({ started: 0, skipped: 1 });
      expect((await s.runs()).map((r) => r.status).sort()).toEqual(['queued', 'skipped']);
    } finally {
      await s.e.closeAll();
    }
  });

  it('错过（服务器停了 3 天）+ 跳过：只记一条 skipped，不补跑，下次时间在现在之后', async () => {
    const s = await setup({ kind: 'daily', time: '09:00' }, 'skip');
    try {
      const due = (await s.a()).nextRunAt!;
      s.e.clock.set(new Date(due.getTime() + 3 * 24 * HOUR).toISOString());
      expect(await s.tick()).toEqual({ started: 0, skipped: 1 });
      expect(await s.tick()).toEqual({ started: 0, skipped: 0 });
      expect((await s.runs()).map((r) => r.status)).toEqual(['skipped']);
      expect((await s.a()).nextRunAt!.getTime()).toBeGreaterThan(s.e.clock.now().getTime());
    } finally {
      await s.e.closeAll();
    }
  });

  it('错过 + 补跑最近一次：只补一次（最近那一次），绝不一次补很多次', async () => {
    const s = await setup({ kind: 'daily', time: '09:00' }, 'latest');
    try {
      const due = (await s.a()).nextRunAt!;
      const now = new Date(due.getTime() + 3 * 24 * HOUR + 2 * HOUR); // 第 4 天 11:00
      s.e.clock.set(now.toISOString());
      expect(await s.tick()).toEqual({ started: 1, skipped: 0 });
      expect(await s.tick()).toEqual({ started: 0, skipped: 0 });
      const runs = await s.runs();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.scheduledFor!.getTime()).toBe(due.getTime() + 3 * 24 * HOUR);
      expect(s.started).toEqual([runs[0]!.id]);
    } finally {
      await s.e.closeAll();
    }
  });

  it('暂停的助手不会被定时触发', async () => {
    const s = await setup({ kind: 'interval', everyHours: 1 });
    try {
      s.e.clock.set(new Date(s.e.clock.now().getTime() + 5 * HOUR).toISOString());
      await s.e.owner('POST', `/api/assistants/${s.id}/pause`);
      expect(await s.tick()).toEqual({ started: 0, skipped: 0 });
      expect(await s.runs()).toEqual([]);
    } finally {
      await s.e.closeAll();
    }
  });
});

describe.each(rlsTargets)('助手存储在应用角色下按账号隔离（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  const T0 = new Date('2026-11-05T06:00:00Z');

  async function seed(db: Db, store: AssistantStore, userId: string): Promise<Assistant> {
    await db.query(`SELECT set_config('app.user_id', $1, false)`, [userId]);
    await db.query(`INSERT INTO members (id, user_id, name, created_at, updated_at) VALUES ('m-1', $1, 'M', now(), now())`, [userId]);
    await db.query(`SELECT set_config('app.user_id', '', false)`);
    const a: Assistant = {
      id: randomUUID(), userId, name: 'A', instructions: '0123456789', leadMemberId: 'm-1', members: [{ memberId: 'm-1', role: 'lead', position: 0 }],
      enabled: true, schedule: { kind: 'interval', everyHours: 1 }, timezone: 'Asia/Shanghai', catchUp: 'skip', maxRuntimeSec: 600, budgetLevel: 'low', notify: true,
      conversationId: randomUUID(), nextRunAt: T0, pausedAt: null, idempotencyKey: null, idempotencyHash: null, createdAt: T0, updatedAt: T0,
    };
    const opening = { id: randomUUID(), conversationId: a.conversationId, userId, role: 'member' as const, memberId: 'm-1', runId: null, content: '我是 A', createdAt: T0 };
    expect(await store.createAssistant(userId, a, { id: a.conversationId, userId, kind: 'assistant', title: 'A', memberIds: ['m-1'], readAt: null, createdAt: T0, updatedAt: T0 }, opening)).toBe('ok');
    return a;
  }
  const run = (a: Assistant, userId: string): AssistantRun => ({
    id: randomUUID(), assistantId: a.id, userId, trigger: 'manual', scheduledFor: null, idempotencyKey: null, requestedAt: T0, startedAt: null, finishedAt: null,
    status: 'queued', failureCode: null, summary: null, usageState: null, calls: 0, messageIds: [],
  });

  it('两个账号的助手互相看不到、触发不了；系统范围只读能找到，但不能写', async () => {
    const db = await target.open();
    dbs.push(db);
    const store = new PgAssistantStore(db);
    const mine = await seed(db, store, 'owner');
    const theirs = await seed(db, store, 'u-b');
    expect((await store.listAssistants('u-b')).map((s) => s.assistant.id)).toEqual([theirs.id]);
    expect(await store.getAssistant('u-b', mine.id)).toBeNull();
    await expect(store.insertRun('u-b', run(mine, 'u-b'))).rejects.toThrow();
    expect(await store.claimDue('u-b', mine.id, T0, async () => 'claimed')).toBeNull();
    expect(await store.listMessages('u-b', mine.conversationId, 10)).toEqual([]);
    expect(await store.markRead('u-b', mine.conversationId, T0)).toBe(false);
    expect(await store.deleteAssistant('u-b', mine.id)).toBe(false);
    expect((await store.systemDueAssistants(T0, 10)).map((x) => x.userId).sort()).toEqual(['owner', 'u-b']);
    await expect(db.tx(async (q) => {
      await q.query(`SELECT set_config('app.system_scope', 'on', true)`);
      await q.query(`UPDATE assistants SET name = 'hacked'`);
      const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM assistants WHERE name = 'hacked'`);
      if (rows[0]!.n > 0) throw new Error('system scope wrote');
    })).resolves.toBeUndefined();
    expect((await store.getAssistant('owner', mine.id))!.name).toBe('A');
  });
});

describe('startOfDay（每天额度的 0 点）', () => {
  it('阶段 2 预审：夏令时切换当天也取对当地 0 点（以前按「现在」的偏移算，差 1 小时）', () => {
    // 纽约 2026-03-08 02:00 进夏令时：0 点还是 EST（UTC-5）
    expect(startOfDay(new Date('2026-03-08T15:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    // 纽约 2026-11-01 02:00 出夏令时：0 点还是 EDT（UTC-4）
    expect(startOfDay(new Date('2026-11-01T17:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // 没有夏令时的时区不变
    expect(startOfDay(new Date('2026-11-05T10:38:00Z'), 'Asia/Shanghai').toISOString()).toBe('2026-11-04T16:00:00.000Z');
    expect(startOfDay(new Date('2026-11-05T17:00:00Z'), 'Asia/Shanghai').toISOString()).toBe('2026-11-05T16:00:00.000Z');
  });
});
