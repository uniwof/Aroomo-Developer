/**
 * 负责人裁定 12：同一个助手最多只有 1 次「等确认」的运行，超过 24 小时自动作废。
 * 定时 / 立即运行在上一次还在等确认时跳过，不会每天多一张付费确认卡。memory + PGlite（+ CI 真 PG）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIRM_EXPIRED_TEXT, WAITING_SKIP_TEXT, type AssistantRun } from '../src/assistants/types.js';
import { CONFIRM_EXPIRY_JOB, schedulerTick } from '../src/scheduler/assistant-scheduler.js';
import { assistantEnv, type AssistantEnv, LEAD, PAID } from './helpers/assistants.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DAY = 24 * 3_600_000;

describe.each(twoAccountEnvs)('等确认最多一张、24 小时作废（裁定 12）[$name]', (env) => {
  let e: AssistantEnv;
  beforeAll(async () => {
    e = await assistantEnv(env);
  });
  afterAll(async () => {
    await e.closeAll();
  });

  const startRun = async (id: string) => {
    const r = await e.owner('POST', `/api/assistants/${id}/runs`);
    await e.app.assistants.runner.idle();
    return r;
  };
  const getRun = async (id: string, runId: string) => (await e.owner('GET', `/api/assistants/${id}/runs/${runId}`)).json().run as J;
  const cards = async (runId?: string) => {
    const g = (await e.owner('GET', '/api/inbox')).json().groups as Record<string, J[]>;
    return Object.values(g)
      .flat()
      .filter((i) => i.kind === 'assistant.run.confirm' && i.status === 'open' && (!runId || i.related?.id === runId));
  };
  const paidAssistant = (name: string, schedule: Record<string, unknown> = { kind: 'manual' }) =>
    e.create({ name: `${name}-${randomUUID().slice(0, 4)}`, members: [LEAD.id, PAID.id], budgetLevel: 'mid', schedule });

  it('过期作废任务总是注册（不受定时执行器总开关影响）', () => {
    expect(e.app.jobs.names()).toContain(CONFIRM_EXPIRY_JOB);
  });

  it('立即运行：上一次还在等确认 → 409 RUN_WAITING_CONFIRMATION，不开新的一次，确认卡只有一张', async () => {
    const id = await paidAssistant('立即');
    const first = await startRun(id);
    expect(first.statusCode, first.body).toBe(202);
    const runId = first.json().run.id as string;
    expect((await getRun(id, runId)).status).toBe('waiting_confirmation');
    const again = await startRun(id);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('RUN_WAITING_CONFIRMATION');
    expect((await e.owner('GET', `/api/assistants/${id}/runs`)).json().runs).toHaveLength(1);
    expect(await cards()).toHaveLength(1);
    // 收尾：拒绝掉，别影响后面的用例
    expect((await e.owner('POST', `/api/inbox/${(await cards(runId))[0]!.id}/actions/reject`)).statusCode).toBe(200);
  });

  it('定时到点：上一次还在等确认 → 这一次记 skipped（写明原因），不开始、不再发卡', async () => {
    const id = await paidAssistant('定时', { kind: 'interval', everyHours: 1 });
    const store = e.deps.assistants;
    const started: string[] = [];
    const tick = () => schedulerTick({ store, start: (u, r) => { started.push(r); e.app.assistants.runner.start(u, r); }, now: e.clock.now });
    e.clock.set((await store.getAssistant('owner', id))!.nextRunAt!.toISOString());
    expect((await tick()).started).toBe(1);
    await e.app.assistants.runner.idle();
    const waiting = await store.findWaitingRun('owner', id);
    expect(waiting?.status).toBe('waiting_confirmation');
    e.clock.set((await store.getAssistant('owner', id))!.nextRunAt!.toISOString());
    expect(await tick()).toEqual({ started: 0, skipped: 1 });
    const runs = await store.listRuns('owner', id, 10);
    expect(runs.map((r) => r.status).sort()).toEqual(['skipped', 'waiting_confirmation']);
    expect(runs.find((r) => r.status === 'skipped')!.summary).toBe(WAITING_SKIP_TEXT);
    expect(await cards()).toHaveLength(1);
    expect((await e.owner('POST', `/api/inbox/${(await cards(waiting!.id))[0]!.id}/actions/reject`)).statusCode).toBe(200);
  });

  it('并发漏网：另一次已经在等确认时，执行到付费那一步的这次记 skipped，不发第二张卡（库层唯一索引兜底）', async () => {
    const id = await paidAssistant('并发');
    const first = (await startRun(id)).json().run.id as string;
    // 绕过接口直接插一条 queued（模拟检查之后、进入等确认之前的并发）
    const raw: AssistantRun = {
      id: randomUUID(), assistantId: id, userId: 'owner', trigger: 'manual', scheduledFor: null, idempotencyKey: null, requestedAt: e.clock.now(),
      startedAt: null, finishedAt: null, status: 'queued', failureCode: null, summary: null, usageState: null, calls: 0, messageIds: [],
    };
    expect(await e.deps.assistants.insertRun('owner', raw)).toBe('ok');
    e.app.assistants.runner.start('owner', raw.id);
    await e.app.assistants.runner.idle();
    expect(await getRun(id, raw.id)).toMatchObject({ status: 'skipped' });
    expect((await getRun(id, first)).status).toBe('waiting_confirmation');
    expect(await cards()).toHaveLength(1);
    // 库层：再把它改成等确认会被唯一索引挡住（比较并交换返回 null）
    expect(await e.deps.assistants.updateRun('owner', raw.id, ['skipped'], { status: 'waiting_confirmation' })).toBeNull();
    expect((await e.owner('POST', `/api/inbox/${(await cards(first))[0]!.id}/actions/reject`)).statusCode).toBe(200);
  });

  it('超过 24 小时没人确认：运行作废（cancelled + 写明过期），确认卡过期、点同意无效；之后又能运行', async () => {
    const id = await paidAssistant('过期');
    const runId = (await startRun(id)).json().run.id as string;
    const card = (await cards(runId))[0]!;
    e.clock.advance(DAY - 60_000);
    expect(await e.app.assistants.runner.expireStaleConfirmations()).toBe(0);
    e.clock.advance(2 * 60_000);
    expect(await e.app.assistants.runner.expireStaleConfirmations()).toBe(1);
    expect(await e.app.assistants.runner.expireStaleConfirmations()).toBe(0); // 幂等
    const r = await getRun(id, runId);
    expect(r).toMatchObject({ status: 'cancelled', summary: CONFIRM_EXPIRED_TEXT });
    expect((r.steps as J[]).find((s) => s.action === 'confirm')).toMatchObject({ status: 'skipped' });
    expect(await cards(runId)).toHaveLength(0);
    const msgs = (await e.owner('GET', `/api/assistants/${id}/messages`)).json().messages as J[];
    expect(msgs.at(-1)).toMatchObject({ role: 'system', content: CONFIRM_EXPIRED_TEXT });
    const late = await e.owner('POST', `/api/inbox/${card.id}/actions/approve`);
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error).toMatchObject({ code: 'ALREADY_RESOLVED', status: 'expired' });
    expect(e.gw.calls).not.toContain(PAID.name);
    const next = await startRun(id);
    expect(next.statusCode, next.body).toBe(202);
    expect((await getRun(id, next.json().run.id)).status).toBe('waiting_confirmation');
    expect((await e.owner('POST', `/api/inbox/${(await cards(next.json().run.id))[0]!.id}/actions/reject`)).statusCode).toBe(200);
  });
});
