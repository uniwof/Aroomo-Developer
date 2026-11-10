/**
 * 假时钟 3：过期记录定时清理（工单 #230）。
 * - confirm-cleanup：确认记录过期超过 1 天才删；没过期的、刚过期的都不动。
 * - inbox-tidy：简报 3 天、低紧急 7 天后变 expired（不删除）；拍板类、重要确认类不动。
 *   所有者和家人账号按同一套规则各收各的（工单 #240），互不串号。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/inbox/types.js';
import { clockApp, type ClockApp } from './helpers/clock-app.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

const SEC = 1000;
const DAY = 24 * 60 * 60 * SEC;

describe.each(twoAccountEnvs)('过期记录清理（$name）', (env) => {
  const open: ClockApp[] = [];
  afterEach(async () => {
    for (const t of open.splice(0)) await t.app.close();
  });

  it('confirm-cleanup：过期不满 1 天的留着，满 1 天才删；没过期的新卡不动', async () => {
    const t = await clockApp(env, { start: '2026-10-27T10:00:00+08:00' });
    open.push(t);
    const startPurge = async (name: string) => {
      await t.owner('POST', '/api/members', { name });
      await t.owner('DELETE', `/api/members/${name.toLowerCase()}`);
      const r = await t.owner('POST', `/api/members/${name.toLowerCase()}/purge`);
      return r.json().error.confirm.id as string;
    };
    const old = await startPurge('Old'); // 10:00 创建，10:05 过期
    t.clock.advance(DAY); // 次日 10:00：已过期 23 小时 55 分
    expect(await t.app.jobs.runOnce('confirm-cleanup')).toBe('');
    expect(await t.deps.confirmChallenges.get('owner', old)).not.toBeNull();

    const fresh = await startPurge('Fresh'); // 次日 10:00 创建，还没过期
    t.clock.advance(5 * 60 * SEC + SEC); // 次日 10:05:01：Old 过期刚好满 1 天又 1 秒
    expect(await t.app.jobs.runOnce('confirm-cleanup')).toBe('deleted=1');
    expect(await t.deps.confirmChallenges.get('owner', old)).toBeNull();
    expect(await t.deps.confirmChallenges.get('owner', fresh)).not.toBeNull(); // 刚过期的不删
    expect(await t.app.jobs.runOnce('confirm-cleanup')).toBe('');
  });

  it('confirm-cleanup 只清确认记录：成员数据和审计记录不受影响；小号的数据不受牵连', async () => {
    const t = await clockApp(env, { start: '2026-10-27T10:00:00+08:00' });
    open.push(t);
    await t.owner('POST', '/api/members', { name: 'Keep' });
    await t.owner('DELETE', '/api/members/keep');
    await t.owner('POST', '/api/members/keep/purge'); // 留下一张确认卡
    const before = (await t.xiao('GET', '/api/auth/me')).json().user;
    t.clock.advance(3 * DAY);
    expect(await t.app.jobs.runOnce('confirm-cleanup')).toBe('deleted=1');
    expect((await t.owner('GET', '/api/members?deleted=true')).json().members.map((m: { id: string }) => m.id)).toContain('keep');
    expect((await t.xiao('GET', '/api/auth/me')).json().user).toEqual(before);
    const audit = (await t.deps.auditLog.query({ limit: 100 })).entries.map((e) => e.action);
    expect(audit).toContain('job.run');
  });

  describe('inbox-tidy', () => {
    const card = (over: Partial<InboxItem>, at: Date): InboxItem => ({
      id: randomUUID(),
      group: 'brief',
      kind: 'daily',
      urgency: 'normal',
      title: '卡',
      summary: '',
      actions: [],
      status: 'open',
      createdAt: at,
      ...over,
    });
    const statusOf = async (t: ClockApp, title: string, userId?: string) =>
      (await t.deps.inbox.list({ ...(userId ? { userId } : {}) })).find((i) => i.title === title)?.status;

    it('2 天 23 小时还在，3 天零 1 秒过期；过期的只是改状态，不删除', async () => {
      const t = await clockApp(env, { start: '2026-10-31T10:00:00+08:00' });
      open.push(t);
      await t.deps.inbox.insertDedup(card({ title: '旧简报' }, t.clock.now()));
      t.clock.advance(3 * DAY - SEC);
      expect(await t.app.jobs.runOnce('inbox-tidy')).toBe('');
      expect(await statusOf(t, '旧简报')).toBe('open');
      t.clock.advance(2 * SEC);
      expect(await t.app.jobs.runOnce('inbox-tidy')).toBe('expired=1');
      expect(await statusOf(t, '旧简报')).toBe('expired'); // 仍能查到
    });

    it('跨账号：小号按同一套规则收拾（低紧急过期、拍板卡不动），所有者与小号互不串号（工单 #240）', async () => {
      const t = await clockApp(env, { start: '2026-10-31T10:00:00+08:00' });
      open.push(t);
      await t.deps.inbox.insertDedup(card({ title: 'A旧简报' }, t.clock.now()));
      await t.deps.inbox.insertDedup(card({ title: 'B拍板', group: 'decision', kind: 'ask', actions: [{ id: 'ok', label: '好' }], userId: t.xiaoId }, t.clock.now()));
      await t.deps.inbox.insertDedup(card({ title: 'B旧低紧急', urgency: 'low', group: 'decision', kind: 'fyi', actions: [{ id: 'ack', label: '知道了' }], userId: t.xiaoId }, t.clock.now()));
      t.clock.advance(8 * DAY);
      expect(await t.app.jobs.runOnce('inbox-tidy')).toBe('expired=2'); // 所有者的 A旧简报 + 小号的 B旧低紧急
      expect(await statusOf(t, 'A旧简报')).toBe('expired');
      expect(await statusOf(t, 'B拍板', t.xiaoId)).toBe('open'); // 拍板卡永不自动过期
      expect(await statusOf(t, 'B旧低紧急', t.xiaoId)).toBe('expired');
      expect(await t.app.jobs.runOnce('inbox-tidy')).toBe(''); // 再跑一次没有可收拾的
      // 小号的卡也不会出现在所有者的列表里
      expect(await statusOf(t, 'B拍板')).toBeUndefined();
    });
  });
});
