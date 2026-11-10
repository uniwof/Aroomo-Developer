/** #347 负责人第 1 轮 M1–M4：建任务时的凭据归属校验——全部条目都查、不解密、非 HTTP 入口同样拦、exists 与执行时取凭据结论一致。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ExecutorAgentAdapter } from '../src/adapters/executor-agent.js';
import type { AuditFn } from '../src/audit/types.js';
import { ConfirmService, MemoryChallengeStore } from '../src/confirm/confirm.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { MemoryExecutorStore } from '../src/executor/memory.js';
import { ExecutorService } from '../src/executor/service.js';
import { MAX_TASK_SECRETS } from '../src/executor/types.js';
import { VaultService } from '../src/vault/service.js';
import { dbTargets, fakeClock } from './helpers/db.js';

const U1 = 'u1';
const U2 = 'u2';
const noAudit: AuditFn = async () => {};
const MINE: string[] = Array.from({ length: MAX_TASK_SECRETS }, () => randomUUID());
const OTHERS: string = randomUUID();

function setup() {
  const store = new MemoryExecutorStore();
  const resolve = vi.fn(async () => 'plain');
  const exists = vi.fn(async (u: string, id: string) => u === U1 && MINE.includes(id));
  const svc = new ExecutorService(store, () => new Date('2026-11-10T00:00:00.000Z'), resolve, undefined, undefined, exists);
  const queued = async (u = U1) => (await store.listTasks(u, 500)).length;
  return { svc, store, resolve, exists, queued };
}
const err = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    const x = e as { statusCode?: number; code?: string; message?: string };
    return { status: x.statusCode, code: x.code, message: x.message ?? '' };
  }
};
const sec = (secretId: string) => ({ secretId, field: 'password' });

describe('#347 建任务时校验凭据归属（直接调 service.create，不经 HTTP）', () => {
  it('M1：超过上限（第 11 条是别人的）→ 400，不入队；不截断、不跳过', async () => {
    const t = setup();
    const r = await err(t.svc.create(U1, { kind: 'login', site: 'https://example.com/', secrets: [...MINE, OTHERS].map(sec) }, noAudit));
    expect(r).toMatchObject({ status: 400, code: 'TOO_MANY_SECRETS' });
    expect(await t.queued()).toBe(0);
  });

  it('M1：恰好上限、最后一条是别人的 → 404，不入队（全部条目都查到）', async () => {
    const t = setup();
    const r = await err(t.svc.create(U1, { kind: 'login', site: 'https://example.com/', secrets: [...MINE.slice(0, MAX_TASK_SECRETS - 1), OTHERS].map(sec) }, noAudit));
    expect(r).toMatchObject({ status: 404, code: 'SECRET_NOT_FOUND' });
    expect(r!.message).not.toContain(OTHERS);
    expect(await t.queued()).toBe(0);
  });

  it('M2：建任务不解密——resolveSecret 0 次，exists 每条 1 次', async () => {
    const t = setup();
    const task = await t.svc.create(U1, { kind: 'login', site: 'https://example.com/', secrets: MINE.slice(0, 3).map(sec) }, noAudit);
    expect(task.status).toBe('queued');
    expect(t.resolve).toHaveBeenCalledTimes(0);
    expect(t.exists).toHaveBeenCalledTimes(3);
  });

  it('M3：工具网关适配器（LobeHub / 助理建任务走这里）用任务所属用户校验：别人的 → 错误、不入队；超上限 → 错误、不入队', async () => {
    const t = setup();
    const ad = new ExecutorAgentAdapter(t.svc, t.exists);
    const other = await ad.call('browser_task_create', { kind: 'login', site: 'https://example.com/', secrets: [sec(OTHERS)] }, { userId: U1, audit: noAudit });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other)).not.toContain(OTHERS);
    // U2 引用 U1 的条目：按 U2 自己的保险箱查
    const cross = await ad.call('browser_task_create', { kind: 'login', site: 'https://example.com/', secrets: [sec(MINE[0]!)] }, { userId: U2, audit: noAudit });
    expect(cross).toEqual(other);
    const many = await ad.call('browser_task_create', { kind: 'login', site: 'https://example.com/', secrets: [...MINE, MINE[0]!].map(sec) }, { userId: U1, audit: noAudit });
    expect(many.isError).toBe(true);
    expect(await t.queued(U1)).toBe(0);
    expect(await t.queued(U2)).toBe(0);
    expect(t.resolve).toHaveBeenCalledTimes(0);
  });
});

/** M4：exists（建任务）和 resolveForGateway（执行时取凭据）对每一行结论一致；内存 / PGlite / 真 PG（CI 设了 CORE_TEST_DATABASE_URL 时） */
const envs: { name: string; make: (now: () => Date) => Promise<CoreDeps> }[] = [
  { name: 'memory', make: async (now) => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date) => pgDeps(await t.open(), now) })),
];

describe.each(envs)('#347 M4 exists 与执行时取凭据结论一致（$name）', (env) => {
  it('本人的 / 别人的 / 已删除的 / 不存在的 uuid / 非 uuid / 空串：exists 与 resolveForGateway 每行一致，且都不抛 500', async () => {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const confirm = new ConfirmService(new MemoryChallengeStore(), { now: clock.now, access: { verify: async () => null } });
    const vault = new VaultService(randomBytes(32).toString('base64'), deps.vault, clock.now, confirm);
    const mine = (await vault.create(U1, { name: 'mine', kind: 'password', value: 'pw-1' }, noAudit)).id;
    const theirs = (await vault.create(U2, { name: 'theirs', kind: 'password', value: 'pw-2' }, noAudit)).id;
    const gone = (await vault.create(U1, { name: 'gone', kind: 'password', value: 'pw-3' }, noAudit)).id;
    expect(await deps.vault.erase(U1, gone, clock.now())).toBe(true);
    // 保险箱按账号隔离，没有家人共享条目：家人和所有者用的是同一条规则（user_id 相等 + 未删除）
    const rows: [string, string, boolean][] = [
      ['本人的', mine, true],
      ['别人的', theirs, false],
      ['已删除的', gone, false],
      ['不存在的 uuid', randomUUID(), false],
      ['非 uuid', 'not-a-uuid', false],
      ['空串', '', false],
    ];
    const table = [];
    for (const [label, id, want] of rows) {
      const e = await vault.exists(U1, id);
      const r = (await vault.resolveForGateway(U1, id)) !== null;
      table.push([label, e, r, want]);
    }
    expect(table).toEqual(rows.map(([label, , want]) => [label, want, want, want]));
  });
});
