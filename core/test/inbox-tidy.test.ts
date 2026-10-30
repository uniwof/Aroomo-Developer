import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
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
});
