/**
 * 假时钟 1：每日额度（北京时间零点）清零（工单 #230，D253）。
 * 用满 → 跨零点 → 圆环回到「可用」、可以再记；前一天的次数进「近 7 天」；两个账号各算各的。
 * 说明：每日次数上限目前只驱动圆环状态，Core 不会因为用满而拒绝对话——这里测的是「计数在零点清零」。
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { dayKey } from '../src/usage/service.js';
import { clockApp, type ClockApp } from './helpers/clock-app.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

const CHAT_TOKEN = 'placeholder-chat-token-0123456789abcdefgh';
const MIN = 60_000;

describe('dayKey 的零点边界（北京时间）', () => {
  it('23:59:59.999 还是前一天，00:00:00.000 就是新的一天', () => {
    expect(dayKey(new Date('2026-10-27T23:59:59.999+08:00'))).toBe('20261027');
    expect(dayKey(new Date('2026-10-28T00:00:00.000+08:00'))).toBe('20261028');
    // 同一时刻换成 UTC 写法也一样：UTC 15:59:59 = 北京 23:59:59
    expect(dayKey(new Date('2026-10-27T15:59:59.999Z'))).toBe('20261027');
    expect(dayKey(new Date('2026-10-27T16:00:00.000Z'))).toBe('20261028');
  });
});

describe.each(twoAccountEnvs)('每日额度跨零点清零（$name）', (env) => {
  const open: ClockApp[] = [];
  afterEach(async () => {
    for (const t of open.splice(0)) await t.app.close();
  });

  async function setup() {
    const t = await clockApp(env, {
      start: '2026-10-27T23:50:00+08:00',
      config: {
        CORE_CHAT_TOKEN: CHAT_TOKEN,
        LITELLM_BASE_URL: 'http://litellm.invalid',
        LITELLM_MASTER_KEY: 'placeholder-master-key-for-tests-0001',
        VAULT_KEY: randomBytes(32).toString('base64'),
      },
      prepare: (deps) => {
        deps.chatFetch = (async () =>
          new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch;
      },
    });
    open.push(t);
    const say = () =>
      t.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${CHAT_TOKEN}` },
        payload: { model: 'aroomo/alpha', messages: [{ role: 'user', content: 'hi' }] },
      });
    expect((await t.owner('POST', '/api/members', { name: 'Alpha' })).statusCode).toBe(201);
    expect((await t.owner('PUT', '/api/usage/limits/alpha', { dailyLimit: 3 })).statusCode).toBe(200);
    const alpha = async () => {
      const r = (await t.owner('GET', '/api/usage')).json();
      return { day: r.day as string, row: r.members.find((m: { memberId: string }) => m.memberId === 'alpha') };
    };
    return { t, say, alpha };
  }

  it('23:50 用满 3 次 → 00:10 圆环回到可用、今天从 0 开始，昨天的 3 次进近 7 天', async () => {
    const { t, say, alpha } = await setup();
    for (let i = 0; i < 3; i++) expect((await say()).statusCode).toBe(200);
    const before = await alpha();
    expect(before.day).toBe('20261027');
    expect(before.row).toMatchObject({ today: { requests: 3 }, state: 'full', last7DaysRequests: 3 });

    t.clock.advance(20 * MIN); // 00:10，已经是 10-28
    const after = await alpha();
    expect(after.day).toBe('20261028');
    expect(after.row.today.requests).toBe(0);
    expect(after.row.state).toBe('ok');
    expect(after.row.quota).toMatchObject({ used: 0, limit: 3 });
    expect(after.row.last7DaysRequests).toBe(3);

    expect((await say()).statusCode).toBe(200); // 零点后还能再用
    const again = await alpha();
    expect(again.row.today.requests).toBe(1);
    expect(again.row.last7DaysRequests).toBe(4);
  });

  it('恰好 00:00:00 才清零，23:59:59 还算昨天', async () => {
    const { t, say, alpha } = await setup();
    t.clock.set('2026-10-27T23:59:59+08:00');
    await say();
    expect((await alpha()).row.today.requests).toBe(1);
    t.clock.set('2026-10-28T00:00:00+08:00');
    expect((await alpha()).row.today.requests).toBe(0);
    await say();
    expect((await alpha()).row.today.requests).toBe(1);
  });

  it('跨账号：小号的额度页不含所有者的次数，也改不了所有者成员的上限；所有者的圆环不受小号影响', async () => {
    const { t, say, alpha } = await setup();
    for (let i = 0; i < 3; i++) await say();
    const xiao = (await t.xiao('GET', '/api/usage')).json();
    expect(xiao).toMatchObject({ tracked: false, total: { requests: 0, errors: 0, limited: 0 } });
    expect(JSON.stringify(xiao)).not.toContain('alpha');
    // 小号改所有者成员的上限：像不存在一样被拒
    expect([403, 404]).toContain((await t.xiao('PUT', '/api/usage/limits/alpha', { dailyLimit: 1 })).statusCode);
    expect((await alpha()).row.quota.limit).toBe(3);

    t.clock.advance(20 * MIN); // 跨零点
    expect((await t.xiao('GET', '/api/usage')).json().total.requests).toBe(0);
    expect((await alpha()).row.today.requests).toBe(0);
    expect((await alpha()).row.last7DaysRequests).toBe(3);
  });
});
