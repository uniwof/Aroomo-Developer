import { afterAll, describe, expect, it } from 'vitest';
import { CAPABILITY_SEED } from '../src/capabilities/seed.js';
import { daysLeft } from '../src/capabilities/trials.js';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

const trial = CAPABILITY_SEED.items.find((i) => i.access === 'trial')!;
const free = CAPABILITY_SEED.items.find((i) => i.access === 'free')!;

describe('试用到期提醒（M4）', () => {
  const clock = fakeClock();
  clock.set('2026-10-31T10:00:00+08:00');
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(clock.now));
  afterAll(() => app.close());
  const put = (id: string, endsAt: string | null) => app.inject({ method: 'PUT', url: `/api/capabilities/${id}/trial`, headers: ownerAuth, payload: { endsAt } });
  it('剩余天数按北京时间日历日算', () => {
    const now = new Date('2026-10-31T23:30:00+08:00');
    expect(daysLeft('2026-10-31', now)).toBe(0);
    expect(daysLeft('2026-11-03', now)).toBe(3);
    expect(daysLeft('2026-10-30', now)).toBe(-1);
  });

  it('需要登录；非试用能力、坏日期、未知能力被拒', async () => {
    expect((await app.inject({ method: 'PUT', url: `/api/capabilities/${trial.id}/trial`, payload: { endsAt: '2026-12-31' } })).statusCode).toBe(401);
    expect((await put(free.id, '2026-12-31')).statusCode).toBe(400);
    expect((await put(trial.id, '2026-02-30')).statusCode).toBe(400);
    expect((await put(trial.id, '明天')).statusCode).toBe(400);
    expect((await put('nope', '2026-12-31')).statusCode).toBe(404);
  });

  it('填到期日后清单里带剩余天数，清掉后回到 null', async () => {
    const r = await put(trial.id, '2026-11-02');
    expect(r.statusCode).toBe(200);
    expect(r.json().trialDaysLeft).toBe(2);
    const b = (await app.inject({ url: '/api/capabilities', headers: ownerAuth })).json();
    const it1 = b.items.find((i: { id: string }) => i.id === trial.id);
    expect(it1.trialEndsAt).toBe('2026-11-02');
    expect(it1.trialDaysLeft).toBe(2);
    expect(b.items.find((i: { id: string }) => i.id === free.id).trialEndsAt).toBeNull();
    await put(trial.id, null);
    const b2 = (await app.inject({ url: '/api/capabilities', headers: ownerAuth })).json();
    expect(b2.items.find((i: { id: string }) => i.id === trial.id).trialEndsAt).toBeNull();
  });

  it('临近(≤3天)或已过期才发收件箱提醒，同一档不重复发；远期不发', async () => {
    const inbox = async () => (await app.inject({ url: '/api/inbox', headers: ownerAuth })).json();
    await put(trial.id, '2026-12-31');
    expect(await app.jobs.runOnce('trial-expiry')).toBe('');
    await put(trial.id, '2026-11-02');
    expect(await app.jobs.runOnce('trial-expiry')).toBe('reminded=1');
    expect(await app.jobs.runOnce('trial-expiry')).toBe(''); // 去重
    const items = JSON.stringify(await inbox());
    expect(items).toContain('还剩 2 天');
    // 过了到期日：换成「已经到期」另发一张
    clock.set('2026-11-03T09:00:00+08:00');
    expect(await app.jobs.runOnce('trial-expiry')).toBe('reminded=1');
    expect(JSON.stringify(await inbox())).toContain('已经到期');
  });
});
