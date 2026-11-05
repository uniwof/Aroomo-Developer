/**
 * 助手定时执行器（附录 C「执行器」1–3、8；落地方案 v2.1 阶段 3）。**默认关**：ASSISTANT_SCHEDULER_ENABLED 不是 true 时 server.ts 根本不注册这个任务；
 * 关着时「立即运行」照样能用。阶段 3（11-15）才在 staging 打开，生产要所有者确认。
 *
 * 每分钟一次：
 *  1. systemScoped 只读找到期助手（next_run_at ≤ 现在、启用、没暂停）；
 *  2. 对每个助手切到它自己账号的范围，在一个事务里 FOR UPDATE SKIP LOCKED 锁住（Core 重启或多实例也不会重复），
 *     按计划时刻插一条运行（唯一键 (assistant_id, scheduled_for) = 幂等键），推进 next_run_at，提交以后再开始干活。
 *  - 同一个助手同时只跑一次：已有进行中的运行，这一次记 skipped。
 *  - 错过的运行（超过 GRACE_MS）：catch_up=skip 只记一条 skipped；latest 只补最近一次，绝不一次补很多次。
 *  - 最短间隔 1 小时由计划校验保证（schedule.ts）。
 */
import { randomUUID } from 'node:crypto';
import { latestDueAt, nextRunAt } from '../assistants/schedule.js';
import type { Assistant, AssistantRun, AssistantStore } from '../assistants/types.js';
import type { Job } from '../jobs/scheduler.js';

export const SCHEDULER_JOB = 'assistant-scheduler';
/** 到期后这么久以内都算按时（每分钟扫一次，留出余量） */
export const GRACE_MS = 5 * 60_000;
const BATCH = 20;

export interface SchedulerDeps {
  store: AssistantStore;
  start: (userId: string, runId: string) => void;
  now: () => Date;
}

function newRun(a: Assistant, scheduledFor: Date, status: AssistantRun['status'], now: Date): AssistantRun {
  return {
    id: randomUUID(),
    assistantId: a.id,
    userId: a.userId,
    trigger: 'schedule',
    scheduledFor,
    idempotencyKey: null,
    requestedAt: now,
    startedAt: null,
    finishedAt: status === 'skipped' ? now : null,
    status,
    failureCode: null,
    summary: null,
    usageState: null,
    calls: 0,
    messageIds: [],
  };
}

/** 跑一轮；返回这一轮新开始的运行数和记为 skipped 的次数 */
export async function schedulerTick(d: SchedulerDeps): Promise<{ started: number; skipped: number }> {
  const now = d.now();
  let started = 0;
  let skipped = 0;
  for (const due of await d.store.systemDueAssistants(now, BATCH)) {
    const toStart = await d.store.claimDue(due.userId, due.id, now, async (a, tx) => {
      const at = a.nextRunAt!;
      const missed = now.getTime() - at.getTime() > GRACE_MS;
      let runId: string | null = null;
      if (missed && a.catchUp === 'skip') {
        if ((await tx.insertRun(newRun(a, at, 'skipped', now))) === 'ok') skipped++;
      } else {
        const slot = missed ? latestDueAt(a.schedule, a.timezone, now, at) : at;
        const run = newRun(a, slot, 'queued', now);
        if ((await tx.insertRun(run)) === 'ok') runId = run.id;
        // 插不进去：同一时刻已经占过（幂等），或者上一次还没跑完 → 记一条 skipped（同一时刻已占过时这条也插不进去，什么都不发生）
        else if ((await tx.insertRun(newRun(a, slot, 'skipped', now))) === 'ok') skipped++;
      }
      await tx.setNextRunAt(a.id, nextRunAt(a.schedule, a.timezone, now, at));
      return runId;
    });
    if (toStart) {
      d.start(due.userId, toStart);
      started++;
    }
  }
  return { started, skipped };
}

export function assistantSchedulerJob(d: SchedulerDeps): Job {
  return {
    name: SCHEDULER_JOB,
    intervalMs: 60_000,
    firstDelayMs: 60_000,
    run: async () => {
      const r = await schedulerTick(d);
      return r.started || r.skipped ? `started=${r.started} skipped=${r.skipped}` : undefined;
    },
  };
}
