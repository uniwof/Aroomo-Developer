import { describe, expect, it } from 'vitest';
import { MemoryExecutorStore } from '../src/executor/memory.js';
import { PgExecutorStore } from '../src/executor/pg.js';
import type { ExecutorStore, TaskRecord } from '../src/executor/types.js';
import { taskTimeoutJob } from '../src/jobs/jobs.js';
import { dbTargets, fakeClock } from './helpers/db.js';

const HOUR = 3600_000;
const stores: { name: string; make: () => Promise<ExecutorStore> }[] = [
  { name: 'memory', make: async () => new MemoryExecutorStore() },
  ...dbTargets.map((t) => ({ name: t.name, make: async () => new PgExecutorStore(await t.open()) })),
];

describe.each(stores)('任务队列清扫（$name）', (s) => {
  const task = (id: string, over: Partial<TaskRecord>, at: Date): TaskRecord => ({
    id,
    userId: 'owner',
    kind: 'checkin',
    site: 'https://example.com/',
    instruction: '',
    secrets: [],
    options: {},
    status: 'queued',
    executorId: null,
    leaseExpiresAt: null,
    cancelRequested: false,
    lastStage: null,
    lastMessage: null,
    resultSummary: null,
    resultError: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  });

  it('租约过期的 running 退回队列；请求过取消的变 cancelled；排队超 24 小时的置失败；新任务不动', async () => {
    const clock = fakeClock();
    const store = await s.make();
    const t0 = clock.now();
    const ex = await store.upsertExecutor({ id: '11111111-1111-4111-8111-111111111111', userId: 'owner', clientId: 'c1', deviceName: 'pc', platform: 'win32', version: '1', adapters: [],
        allowlistHash: null, createdAt: t0, lastSeenAt: t0 });
    const ids = {
      lapsed: '00000000-0000-4000-8000-000000000001',
      lapsedCancel: '00000000-0000-4000-8000-000000000002',
      alive: '00000000-0000-4000-8000-000000000003',
      stale: '00000000-0000-4000-8000-000000000004',
      fresh: '00000000-0000-4000-8000-000000000005',
    };
    // 三个任务先领取（租约 60 秒），再让两个过期、一个续租
    const q = (id: string, ms: number) => store.insertTask(task(id, {}, new Date(t0.getTime() + ms)));
    await q(ids.lapsed, -3000);
    await q(ids.lapsedCancel, -2000);
    await q(ids.alive, -1000);
    for (let i = 0; i < 3; i++) expect(await store.claim('owner', ex.id, null, t0, new Date(t0.getTime() + 60_000))).not.toBeNull();
    await store.cancel('owner', ids.lapsedCancel, t0);
    const t30 = new Date(t0.getTime() + 30_000);
    expect(await store.renew('owner', ids.alive, ex.id, t30, new Date(t0.getTime() + 600_000), 's', 'm')).not.toBeNull();
    clock.advance(120_000);
    const now = clock.now();
    await store.insertTask(task(ids.stale, {}, new Date(now.getTime() - 25 * HOUR)));
    await store.insertTask(task(ids.fresh, {}, new Date(now.getTime() - HOUR)));

    const note = await taskTimeoutJob(store, clock.now).run(async () => undefined);
    expect(note).toBe('requeued=2 expired=1');
    const st = async (id: string) => (await store.getTask('owner', id))?.status;
    expect(await st(ids.lapsed)).toBe('queued');
    expect(await st(ids.lapsedCancel)).toBe('cancelled');
    expect(await st(ids.alive)).toBe('running');
    expect(await st(ids.stale)).toBe('failed');
    expect((await store.getTask('owner', ids.stale))?.resultError).toBe('NO_EXECUTOR');
    expect(await st(ids.fresh)).toBe('queued');
    // 再跑一次没有新变化
    expect(await taskTimeoutJob(store, clock.now).run(async () => undefined)).toBe('');
  });
});
