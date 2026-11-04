import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuditLog } from '../src/audit/memory.js';
import { bindAudit } from '../src/audit/common.js';
import type { Db } from '../src/db/db.js';
import { HttpError } from '../src/http/errors.js';
import { MemoryMemberStore } from '../src/members/memory.js';
import { PgMemberStore } from '../src/members/pg.js';
import { ConfirmService, MemoryChallengeStore } from '../src/confirm/confirm.js';
import { MembersService } from '../src/members/service.js';
import { challengeOf } from './helpers/confirm.js';
import { type MemberStore, RECYCLE_MS } from '../src/members/types.js';
import { dbTargets, fakeClock } from './helpers/db.js';

type Factory = { name: string; make: () => Promise<{ store: MemberStore; db?: Db }> };
const factories: Factory[] = [
  { name: 'memory', make: async () => ({ store: new MemoryMemberStore() }) },
  ...dbTargets.map<Factory>((t) => ({
    name: t.name,
    make: async () => {
      const db = await t.open();
      return { store: new PgMemberStore(db), db };
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

for (const f of factories) {
  describe(`MembersService（${f.name}）`, () => {
    const dbs: Db[] = [];
    let clock: ReturnType<typeof fakeClock>;
    let svc: MembersService;
    let confirm: ConfirmService;
    let log: MemoryAuditLog;
    let audit: ReturnType<typeof bindAudit>;

    beforeEach(async () => {
      const { store, db } = await f.make();
      if (db) dbs.push(db);
      clock = fakeClock();
      confirm = new ConfirmService(new MemoryChallengeStore(), { now: clock.now });
      svc = new MembersService(store, clock.now, confirm);
      log = new MemoryAuditLog(clock.now);
      audit = bindAudit(log, { type: 'owner', id: 'owner' });
    });
    afterAll(async () => {
      for (const db of dbs) await db.close();
    });

    const tick = () => clock.advance(1000);

    it('新建：自动生成 id、默认启用、排在最后；写审计', async () => {
      const a = await svc.create({ name: '  Gemini   2.5 Pro ', capabilityTags: ['text', 'reasoning', 'text'] }, audit);
      tick();
      const b = await svc.create({ id: 'groq', name: 'Groq', aliases: ['groq', 'GQ', 'gq'] }, audit);
      expect(a).toMatchObject({ id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', capabilityTags: ['text', 'reasoning'], enabled: true, pinned: false, sortOrder: 0 });
      expect(b.aliases).toEqual(['GQ']);
      expect(b.sortOrder).toBe(1);
      expect((await svc.list()).map((m) => m.id)).toEqual(['gemini-2-5-pro', 'groq']);
      const e = (await log.query({ action: 'members.create' })).entries;
      expect(e).toHaveLength(2);
      expect(e[0]).toMatchObject({ result: 'ok', target: { type: 'member', id: 'groq' } });
    });

    it('中文名生成 member-xxxxxx；同名 slug 自动加后缀', async () => {
      const a = await svc.create({ name: '通义千问' }, audit);
      expect(a.id).toMatch(/^member-[0-9a-f]{6}$/);
      const b = await svc.create({ name: 'GPT 4o' }, audit);
      const c = await svc.create({ name: 'gpt-4o' === b.name ? 'x' : 'GPT-4o!' }, audit);
      expect(b.id).toBe('gpt-4o');
      expect(c.id).toBe('gpt-4o-2');
    });

    it('校验：名字为空、非法 id、名字重复（大小写不敏感）、id 重复、别名冲突', async () => {
      await svc.create({ id: 'groq', name: 'Groq', aliases: ['fast'] }, audit);
      expect(await code(svc.create({ name: '   ' }, audit))).toBe('400 INVALID_NAME');
      expect(await code(svc.create({ id: 'Bad_ID', name: 'X' }, audit))).toBe('400 INVALID_ID');
      expect(await code(svc.create({ name: 'GROQ' }, audit))).toBe('409 DUPLICATE_NAME');
      expect(await code(svc.create({ id: 'groq', name: 'Other' }, audit))).toBe('409 DUPLICATE_ID');
      expect(await code(svc.create({ name: 'Other', aliases: ['FAST'] }, audit))).toBe('409 ALIAS_CONFLICT');
      expect(await code(svc.create({ name: 'fast' }, audit))).toBe('409 ALIAS_CONFLICT');
      const failed = (await log.query({ action: 'members.create' })).entries.filter((e) => e.result === 'failed');
      expect(failed.map((e) => e.note)).toContain('DUPLICATE_NAME');
    });

    it('修改：改名、改别名、停用；改成已有名字 409；不存在 404', async () => {
      await svc.create({ id: 'a', name: 'Alpha' }, audit);
      await svc.create({ id: 'b', name: 'Beta' }, audit);
      tick();
      const a = await svc.update('a', { name: 'Alpha 2', enabled: false, aliases: ['al'] }, audit);
      expect(a).toMatchObject({ name: 'Alpha 2', enabled: false, aliases: ['al'] });
      expect(a.updatedAt.getTime()).toBeGreaterThan(a.createdAt.getTime());
      expect(await code(svc.update('a', { name: 'beta' }, audit))).toBe('409 DUPLICATE_NAME');
      expect(await code(svc.update('nope', { name: 'x' }, audit))).toBe('404 NOT_FOUND');
    });

    it('软删除 → 回收站 → 撤销；删除后名字可被复用，撤销时同名则 409', async () => {
      await svc.create({ id: 'a', name: 'Alpha' }, audit);
      await svc.create({ id: 'b', name: 'Beta' }, audit);
      await svc.setPinned('a', true, audit);
      tick();
      const del = await svc.softDelete('a', audit);
      expect(del.deletedAt).not.toBeNull();
      expect(del.pinned).toBe(false);
      expect((await svc.list()).map((m) => m.id)).toEqual(['b']);
      expect((await svc.list({ deleted: true })).map((m) => m.id)).toEqual(['a']);
      expect(await code(svc.update('a', { name: 'x' }, audit))).toBe('404 NOT_FOUND');
      expect(await code(svc.softDelete('a', audit))).toBe('404 NOT_FOUND');

      const restored = await svc.restore('a', audit);
      expect(restored.deletedAt).toBeNull();
      expect((await svc.list()).map((m) => m.id)).toEqual(['b', 'a']); // 撤销后排到最后

      await svc.softDelete('a', audit);
      await svc.create({ id: 'a2', name: 'alpha' }, audit);
      expect(await code(svc.restore('a', audit))).toBe('409 DUPLICATE_NAME');
    });

    it('彻底删除：未在回收站 → 409；重要确认（不可逆，D63）两步完成后才删；成功后不可撤销', async () => {
      const owner = { actor: 'owner', canConfirmImportant: true };
      await svc.create({ id: 'a', name: 'Alpha' }, audit);
      expect(await code(svc.purge('a', owner, audit))).toBe('409 NOT_IN_RECYCLE_BIN');
      await svc.softDelete('a', audit);
      const ch = await challengeOf(svc.purge('a', owner, audit));
      expect(ch).toMatchObject({ kind: 'irreversible', requiresAccessReauth: false, confirmLabel: '彻底删除' });
      expect(ch.consequences.length).toBeGreaterThan(0);
      expect(await svc.list({ deleted: true })).toHaveLength(1);
      await confirm.step(ch.id, 1, { actor: 'owner' }, audit);
      clock.advance(3000);
      const { confirmToken } = await confirm.step(ch.id, 2, { actor: 'owner' }, audit);
      await svc.purge('a', { ...owner, confirmToken: confirmToken as string }, audit);
      expect(await svc.list({ deleted: true })).toEqual([]);
      expect(await code(svc.restore('a', audit))).toBe('404 NOT_FOUND');
      expect(await code(svc.purge('a', owner, audit))).toBe('404 NOT_FOUND');
      const entries = (await log.query({ action: 'members.purge' })).entries;
      expect(entries.map((e) => `${e.result}:${e.note ?? ''}`)).toEqual(['failed:NOT_FOUND', 'ok:', 'failed:NOT_IN_RECYCLE_BIN']);
      expect(await code(svc.purge('zz', { actor: 'operator:x', canConfirmImportant: false }, audit))).toBe('404 NOT_FOUND');
    });

    it('回收站超过 30 天：列表与撤销都不可见；sweepExpired 清理', async () => {
      await svc.create({ id: 'old', name: 'Old' }, audit);
      await svc.create({ id: 'new', name: 'New' }, audit);
      await svc.softDelete('old', audit);
      clock.advance(RECYCLE_MS - 1000);
      await svc.softDelete('new', audit);
      expect((await svc.list({ deleted: true })).map((m) => m.id)).toEqual(['new', 'old']);
      clock.advance(1000);
      expect((await svc.list({ deleted: true })).map((m) => m.id)).toEqual(['new']);
      expect(await code(svc.restore('old', audit))).toBe('404 NOT_FOUND');
      expect(await svc.sweepExpired(audit)).toEqual(['old']);
      expect(await svc.sweepExpired(audit)).toEqual([]);
    });

    it('置顶规则：置顶在前（置顶之间也按 sortOrder），再按 sortOrder', async () => {
      for (const id of ['a', 'b', 'c', 'd']) {
        await svc.create({ id, name: id.toUpperCase() }, audit);
        tick();
      }
      await svc.setPinned('c', true, audit);
      await svc.setPinned('b', true, audit);
      expect((await svc.list()).map((m) => m.id)).toEqual(['b', 'c', 'a', 'd']);
      await svc.setPinned('b', false, audit);
      expect((await svc.list()).map((m) => m.id)).toEqual(['c', 'a', 'b', 'd']);
      expect((await log.query({ action: 'members.pin' })).entries).toHaveLength(2);
      expect((await log.query({ action: 'members.unpin' })).entries).toHaveLength(1);
    });

    it('重排：原子更新；集合不一致（缺、多、重复、含已删除、未知）→ 400 且不改任何数据', async () => {
      for (const id of ['a', 'b', 'c']) await svc.create({ id, name: id.toUpperCase() }, audit);
      await svc.create({ id: 'x', name: 'X' }, audit);
      await svc.softDelete('x', audit);
      const res = await svc.reorder(['c', 'a', 'b'], audit);
      expect(res.map((m) => [m.id, m.sortOrder])).toEqual([
        ['c', 0],
        ['a', 1],
        ['b', 2],
      ]);
      for (const bad of [['c', 'a'], ['c', 'a', 'b', 'b'], ['c', 'a', 'a'], ['c', 'a', 'b', 'x'], ['c', 'a', 'zzz']]) {
        expect(await code(svc.reorder(bad, audit))).toBe('400 INVALID_ORDER');
      }
      expect((await svc.list()).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    });
  });
}
