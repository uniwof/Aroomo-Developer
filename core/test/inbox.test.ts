import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bindAudit } from '../src/audit/common.js';
import { MemoryAuditLog } from '../src/audit/memory.js';
import { type ChallengeStore, CONFIRM_TTL_MS, ConfirmService, MemoryChallengeStore, PgChallengeStore } from '../src/confirm/confirm.js';
import { challengeOf } from './helpers/confirm.js';
import type { Db } from '../src/db/db.js';
import { HttpError } from '../src/http/errors.js';
import { MemoryInboxStore } from '../src/inbox/memory.js';
import { PgInboxStore } from '../src/inbox/pg.js';
import { type CreateInboxInput, InboxService } from '../src/inbox/service.js';
import type { InboxStore } from '../src/inbox/types.js';
import { dbTargets, fakeClock } from './helpers/db.js';

type Factory = { name: string; make: () => Promise<{ store: InboxStore; confirm: ChallengeStore; db?: Db }> };
const factories: Factory[] = [
  { name: 'memory', make: async () => ({ store: new MemoryInboxStore(), confirm: new MemoryChallengeStore() }) },
  ...dbTargets.map<Factory>((t) => ({
    name: t.name,
    make: async () => {
      const db = await t.open();
      return { store: new PgInboxStore(db), confirm: new PgChallengeStore(db), db };
    },
  })),
];

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return `${err.statusCode} ${err.code}`;
    throw err;
  }
  return 'no error';
}

const decision = (over: Partial<CreateInboxInput> = {}): CreateInboxInput => ({
  group: 'decision',
  kind: 'approve-plan',
  title: '要不要采纳方案 B？',
  summary: '负责人建议采纳',
  actions: [
    { id: 'approve', label: '采纳' },
    { id: 'reject', label: '不采纳' },
    { id: 'pay', label: '付款 ¥20', confirm: { kind: 'payment', consequences: ['会从你的账户扣 ¥20，不能撤回。'] } },
  ],
  ...over,
});

for (const f of factories) {
  describe(`InboxService（${f.name}）`, () => {
    const dbs: Db[] = [];
    let clock: ReturnType<typeof fakeClock>;
    let svc: InboxService;
    let confirm: ConfirmService;
    let log: MemoryAuditLog;
    let audit: ReturnType<typeof bindAudit>;
    const owner = { actor: 'owner', canConfirmImportant: true };

    beforeEach(async () => {
      const made = await f.make();
      if (made.db) dbs.push(made.db);
      clock = fakeClock();
      confirm = new ConfirmService(made.confirm, { now: clock.now });
      svc = new InboxService(made.store, confirm, clock.now);
      log = new MemoryAuditLog(clock.now);
      audit = bindAudit(log, { type: 'owner', id: 'owner' });
    });
    afterAll(async () => {
      for (const db of dbs) await db.close();
    });

    it('排序：open 在前，再按紧急度，再按时间（新的在前）', async () => {
      const a = await svc.createInboxItem(decision({ title: 'low-old', urgency: 'low' }), audit);
      clock.advance(1000);
      const b = await svc.createInboxItem(decision({ title: 'normal-old' }), audit);
      clock.advance(1000);
      await svc.createInboxItem(decision({ title: 'urgent', urgency: 'urgent' }), audit);
      clock.advance(1000);
      await svc.createInboxItem(decision({ title: 'normal-new' }), audit);
      await svc.dismiss(b.item.id, audit);
      expect((await svc.list({ group: 'decision' })).map((i) => i.title)).toEqual(['urgent', 'normal-new', 'low-old', 'normal-old']);
      expect((await svc.list({ status: 'open' })).map((i) => i.title)).not.toContain('normal-old');
      expect(a.item.status).toBe('open');
    });

    it('去重：同 related + kind 的 open 条目只保留一条；处理后可再建；无 related 不去重', async () => {
      const rel = { type: 'project', id: 'p1' };
      const first = await svc.createInboxItem(decision({ related: rel }), audit);
      const dup = await svc.createInboxItem(decision({ related: rel, title: '另一个标题' }), audit);
      expect(dup.created).toBe(false);
      expect(dup.item.id).toBe(first.item.id);
      const otherKind = await svc.createInboxItem(decision({ related: rel, kind: 'takeover' }), audit);
      expect(otherKind.created).toBe(true);
      await svc.dismiss(first.item.id, audit);
      expect((await svc.createInboxItem(decision({ related: rel }), audit)).created).toBe(true);
      expect((await svc.createInboxItem(decision(), audit)).created).toBe(true);
      expect((await svc.createInboxItem(decision(), audit)).created).toBe(true);
      expect((await log.query({ action: 'inbox.create_deduped' })).entries).toHaveLength(1);
    });

    it('未读计数按组统计 open', async () => {
      await svc.createInboxItem(decision(), audit);
      await svc.createInboxItem(decision({ group: 'candidate' }), audit);
      const brief = await svc.createInboxItem(decision({ group: 'brief', actions: [] }), audit);
      await svc.dismiss(brief.item.id, audit);
      expect(await svc.unreadCount()).toEqual({ total: 2, byGroup: { decision: 1, candidate: 1, brief: 0 } });
    });

    it('执行动作：成功一次；再次执行（任何动作）409；状态流转 open → done 并记录动作', async () => {
      const { item } = await svc.createInboxItem(decision(), audit);
      clock.advance(5000);
      const r = await svc.act(item.id, 'approve', owner, audit);
      expect(r).toMatchObject({ status: 'done', resolvedAction: 'approve' });
      expect(r.resolvedAt?.toISOString()).toBe('2026-10-27T00:00:05.000Z');
      // 普通确认：点一下即执行，记 confirm.normal
      expect((await log.query({ action: 'confirm.normal' })).entries).toHaveLength(1);
      expect(await code(svc.act(item.id, 'approve', owner, audit))).toBe('409 ALREADY_RESOLVED');
      expect(await code(svc.act(item.id, 'reject', owner, audit))).toBe('409 ALREADY_RESOLVED');
      expect(await code(svc.dismiss(item.id, audit))).toBe('409 ALREADY_RESOLVED');
      expect(await code(svc.act(item.id, 'nope', owner, audit))).toBe('400 UNKNOWN_ACTION');
      expect(await code(svc.act('00000000-0000-0000-0000-000000000000', 'approve', owner, audit))).toBe('404 NOT_FOUND');
    });

    it('并发：Promise.all 同时发两次（同一动作 / 不同动作），只有一个成功，其余 409', async () => {
      const { item } = await svc.createInboxItem(decision(), audit);
      const results = await Promise.allSettled([
        svc.act(item.id, 'approve', owner, audit),
        svc.act(item.id, 'approve', owner, audit),
        svc.act(item.id, 'reject', owner, audit),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(2);
      for (const r of rejected) expect((r.reason as HttpError).code).toBe('ALREADY_RESOLVED');
      const ok = (await log.query({ action: 'inbox.action.execute' })).entries.filter((e) => e.result === 'ok');
      expect(ok).toHaveLength(1);
    });

    /** 重要确认走完两步，返回一次性令牌 */
    async function tokenFor(id: string, actor = 'owner') {
      await confirm.step(id, 1, { actor }, audit);
      clock.advance(3000);
      const out = await confirm.step(id, 2, { actor }, audit);
      return out.confirmToken as string;
    }

    it('重要动作（花钱）：无令牌 428 + challenge（含后果），不执行；两步确认后带令牌才执行；全程审计', async () => {
      const { item } = await svc.createInboxItem(decision(), audit);
      const ch = await challengeOf(svc.act(item.id, 'pay', owner, audit));
      expect(ch).toMatchObject({ level: 'important', kind: 'payment', steps: 2, nextStep: 1, minDelayMs: 3000, requiresAccessReauth: false });
      expect(ch.consequences).toEqual(['会从你的账户扣 ¥20，不能撤回。']);
      expect(new Date(ch.expiresAt).getTime() - clock.now().getTime()).toBe(CONFIRM_TTL_MS);
      expect((await svc.list({ status: 'open' })).map((i) => i.id)).toContain(item.id);
      const token = await tokenFor(ch.id);
      expect(token.length).toBeGreaterThanOrEqual(32);
      const done = await svc.act(item.id, 'pay', { ...owner, confirmToken: token }, audit);
      expect(done.status).toBe('done');
      const actions = (await log.query({ limit: 20 })).entries.map((e) => `${e.action}:${e.result}`).reverse();
      expect(actions).toEqual([
        'inbox.create:ok',
        'confirm.requested:ok',
        'confirm.step1:ok',
        'confirm.step2:ok',
        'confirm.consumed:ok',
        'inbox.action.execute:ok',
      ]);
      const exec = (await log.query({ action: 'inbox.action.execute' })).entries[0];
      expect(exec?.note).toContain('payment');
    });

    it('旧写法 irreversible: true 仍按重要确认（不可逆）处理，并有默认后果文字', async () => {
      const { item } = await svc.createInboxItem(decision({ actions: [{ id: 'del', label: '永久删除', irreversible: true }] }), audit);
      expect(item.actions[0]).toEqual({ id: 'del', label: '永久删除', confirm: { kind: 'irreversible', consequences: ['这个操作不可撤销。'] } });
      const ch = await challengeOf(svc.act(item.id, 'del', owner, audit));
      expect(ch.kind).toBe('irreversible');
    });

    it('重要动作必须写后果', async () => {
      expect(await code(svc.createInboxItem(decision({ actions: [{ id: 'x', label: 'X', confirm: { kind: 'irreversible' } }] }), audit))).toBe(
        '400 CONSEQUENCES_REQUIRED',
      );
    });

    it('令牌：过期、伪造、换操作者、换事项、重放都失败', async () => {
      const a = (await svc.createInboxItem(decision(), audit)).item;
      const t1 = await tokenFor((await challengeOf(svc.act(a.id, 'pay', owner, audit))).id);
      clock.advance(CONFIRM_TTL_MS);
      expect(await code(svc.act(a.id, 'pay', { ...owner, confirmToken: t1 }, audit))).toBe('409 CONFIRM_EXPIRED');
      expect(await code(svc.act(a.id, 'pay', { ...owner, confirmToken: 'forged-token' }, audit))).toBe('409 CONFIRM_INVALID');
      const t2 = await tokenFor((await challengeOf(svc.act(a.id, 'pay', owner, audit))).id);
      expect(await code(svc.act(a.id, 'pay', { actor: 'someone-else', canConfirmImportant: true, confirmToken: t2 }, audit))).toBe('409 CONFIRM_INVALID');
      const b = (await svc.createInboxItem(decision({ title: 'b' }), audit)).item;
      expect(await code(svc.act(b.id, 'pay', { ...owner, confirmToken: t2 }, audit))).toBe('409 CONFIRM_INVALID');
      expect((await svc.act(a.id, 'pay', { ...owner, confirmToken: t2 }, audit)).status).toBe('done');
      const t3 = await tokenFor((await challengeOf(svc.act(b.id, 'pay', owner, audit))).id);
      await svc.act(b.id, 'pay', { ...owner, confirmToken: t3 }, audit);
      const c = (await svc.createInboxItem(decision({ title: 'c' }), audit)).item;
      expect(await code(svc.act(c.id, 'pay', { ...owner, confirmToken: t3 }, audit))).toBe('409 CONFIRM_INVALID');
      const failed = (await log.query({ action: 'inbox.action.execute', limit: 50 })).entries.filter((e) => e.result === 'failed');
      expect(failed.length).toBe(5);
    });

    it('同一令牌并发两次，只执行一次', async () => {
      const { item } = await svc.createInboxItem(decision(), audit);
      const t = await tokenFor((await challengeOf(svc.act(item.id, 'pay', owner, audit))).id);
      const rs = await Promise.allSettled([
        svc.act(item.id, 'pay', { ...owner, confirmToken: t }, audit),
        svc.act(item.id, 'pay', { ...owner, confirmToken: t }, audit),
      ]);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('操作员不能完成重要确认 → 403 并审计 denied（D62）', async () => {
      const { item } = await svc.createInboxItem(decision(), audit);
      expect(await code(svc.act(item.id, 'pay', { actor: 'operator:x', canConfirmImportant: false }, audit))).toBe('403 FORBIDDEN');
      const e = (await log.query({ action: 'inbox.action.execute' })).entries[0];
      expect(e?.result).toBe('denied');
      expect((await log.query({ action: 'confirm.denied' })).entries).toHaveLength(1);
    });

    it('忽略、批量忽略、到期', async () => {
      const a = (await svc.createInboxItem(decision({ title: 'a' }), audit)).item;
      const b = (await svc.createInboxItem(decision({ title: 'b' }), audit)).item;
      const c = (await svc.createInboxItem(decision({ title: 'c' }), audit)).item;
      const d = (await svc.createInboxItem(decision({ title: 'd' }), audit)).item;
      expect((await svc.dismiss(a.id, audit)).status).toBe('dismissed');
      const r = await svc.dismissMany([a.id, b.id, c.id, c.id, '00000000-0000-0000-0000-000000000000'], audit);
      expect(r.dismissed).toEqual([b.id, c.id]);
      expect(r.skipped).toEqual([
        { id: a.id, reason: 'ALREADY_RESOLVED' },
        { id: '00000000-0000-0000-0000-000000000000', reason: 'NOT_FOUND' },
      ]);
      expect((await svc.expire(d.id, audit))?.status).toBe('expired');
      expect(await svc.expire(d.id, audit)).toBeNull();
      expect(await svc.unreadCount()).toMatchObject({ total: 0 });
    });

    it('新建校验：标题为空、动作 id 重复或非法', async () => {
      expect(await code(svc.createInboxItem(decision({ title: '  ' }), audit))).toBe('400 INVALID_TITLE');
      expect(await code(svc.createInboxItem(decision({ actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), audit))).toBe('400 INVALID_ACTIONS');
      expect(await code(svc.createInboxItem(decision({ actions: [{ id: 'A B', label: 'x' }] }), audit))).toBe('400 INVALID_ACTIONS');
    });
  });
}
