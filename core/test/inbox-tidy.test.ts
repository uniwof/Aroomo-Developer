import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { InboxService } from '../src/inbox/service.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

describe('收件箱自动收拾（M4）', () => {
  const clock = fakeClock();
  clock.set('Sat 2026-10-31 10:00 AM CST (UTC+08:00)');
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(clock.now));
  afterAll(() => app.close());
  const post = (payload: object) => app.inject({ method: 'POST', url: '/api/inbox', headers: ownerAuth, payload });
  const status = async (title: string) => {
    const all = (await app.inject({ url: '/api/inbox', headers: ownerAuth })).json().groups;
    return Object.values(all as Record<string, Array<{ title: string; status: string }>>).flat().find((i) => i.title === title)?.status;
  };

  it('简报 3 天、低紧急度 7 天后过期；拍板类和重要确认类永不过期', async () => {
    await post({ group: 'brief', kind: 'daily', title: '简报' });
    await post({ group: 'decision', kind: 'fyi', urgency: 'low', title: '低紧急', actions: [{ id: 'ack', label: '知道了' }] });
    await post({ group: 'decision', kind: 'ask', urgency: 'normal', title: '要拍板', actions: [{ id: 'ok', label: '好' }] });
    await post({
      group: 'decision',
      kind: 'pay',
      urgency: 'low',
      title: '低紧急但要花钱',
      actions: [{ id: 'pay', label: '付款', confirm: { kind: 'payment', consequences: ['会扣款'] } }],
    });
    expect(await app.jobs.runOnce('inbox-tidy')).toBe('');

    clock.set('Tue 2026-11-03 11:00 AM CST (UTC+08:00)'); // +3 天零 1 小时
    expect(await app.jobs.runOnce('inbox-tidy')).toBe('expired=1');
    expect(await status('简报')).toBe('expired');
    expect(await status('低紧急')).toBe('open');

    clock.set('Sun 2026-11-08 11:00 AM CST (UTC+08:00)'); // +8 天
    expect(await app.jobs.runOnce('inbox-tidy')).toBe('expired=1');
    expect(await status('低紧急')).toBe('expired');
    expect(await status('要拍板')).toBe('open');
    expect(await status('低紧急但要花钱')).toBe('open');
    expect(await app.jobs.runOnce('inbox-tidy')).toBe('');
  });

  it('家人账号的卡同样按规则过期，拍板卡不动，所有者的卡不受影响', async () => {
    const c2 = fakeClock();
    c2.set('Mon 2026-11-09 10:00 AM CST (UTC+08:00)');
    const deps = memoryDeps(c2.now);
    const app2 = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
    try {
      const inv = await app2.inject({ method: 'POST', url: '/api/users/invites', headers: ownerAuth, payload: { email: 'kid@example.test' } });
      await app2.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: 'correct-horse-battery' } });
      const kidId = (await deps.users.getUserByEmail('kid@example.test'))!.id;
      const svc = new InboxService(deps.inbox, undefined as never, c2.now);
      const noAudit = (async () => undefined) as never;
      await svc.createInboxItem({ group: 'brief', kind: 'daily', title: '小号简报', userId: kidId }, noAudit);
      await svc.createInboxItem({ group: 'decision', kind: 'ask', urgency: 'normal', title: '小号拍板', userId: kidId, actions: [{ id: 'ok', label: '好' }] }, noAudit);
      await svc.createInboxItem({ group: 'brief', kind: 'daily', title: '所有者简报' }, noAudit);
      c2.set('Fri 2026-11-13 10:00 AM CST (UTC+08:00)'); // +4 天
      expect(await app2.jobs.runOnce('inbox-tidy')).toBe('expired=2');
      const st = async (userId?: string) => (await deps.inbox.list({ ...(userId ? { userId } : {}) })).map((i) => `${i.title}:${i.status}`).sort();
      expect(await st(kidId)).toEqual(['小号拍板:open', '小号简报:expired']);
      expect(await st()).toEqual(['所有者简报:expired']);
    } finally {
      await app2.close();
    }
  });
});
