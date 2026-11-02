import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

describe('GET /api/inbox?type=（控制台按类型过滤）', () => {
  const clock = fakeClock();
  clock.set('Sat 2026-10-31 10:00 AM CST (UTC+08:00)');
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(clock.now));
  afterAll(() => app.close());
  const post = (payload: object) => app.inject({ method: 'POST', url: '/api/inbox', headers: ownerAuth, payload });
  const titles = async (type: string) => {
    const r = await app.inject({ url: `/api/inbox?type=${type}`, headers: ownerAuth });
    expect(r.statusCode).toBe(200);
    return Object.values(r.json().groups as Record<string, Array<{ title: string }>>).flat().map((i) => i.title).sort();
  };

  it('confirm / takeover / brief 各取各的', async () => {
    await post({ group: 'brief', kind: 'daily', title: '简报' });
    await post({ group: 'decision', kind: 'executor.takeover', title: '接管', actions: [{ id: 'done', label: '好了' }] });
    await post({ group: 'decision', kind: 'pay', title: '付款', actions: [{ id: 'pay', label: '付', confirm: { kind: 'payment', consequences: ['扣款'] } }] });
    await post({ group: 'decision', kind: 'ask', title: '普通', actions: [{ id: 'ok', label: '好' }] });
    expect(await titles('brief')).toEqual(['简报']);
    expect(await titles('takeover')).toEqual(['接管']);
    expect(await titles('confirm')).toEqual(['付款']);
    const g = await app.inject({ url: '/api/inbox?type=confirm&group=decision', headers: ownerAuth });
    expect(g.json().items.map((i: { title: string }) => i.title)).toEqual(['付款']);
    expect((await app.inject({ url: '/api/inbox?type=nope', headers: ownerAuth })).statusCode).toBe(400);
  });
});
