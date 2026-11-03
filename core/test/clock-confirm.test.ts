/**
 * 假时钟 2：确认卡 5 分钟过期（工单 #230，D63）。
 * 4:59 还能确认并执行；5:01 被拒且不执行；已拿到的令牌过期后也不能用；别的账号碰不到所有者的确认卡。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS } from '../src/confirm/confirm.js';
import { clockApp, type ClockApp } from './helpers/clock-app.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

const SEC = 1000;

describe('确认卡有效期常量', () => {
  it('5 分钟', () => expect(CONFIRM_TTL_MS).toBe(5 * 60 * SEC));
});

describe.each(twoAccountEnvs)('确认卡 5 分钟过期（$name）', (env) => {
  const open: ClockApp[] = [];
  afterEach(async () => {
    for (const t of open.splice(0)) await t.app.close();
  });

  /** 所有者建一个已删除成员，发起「彻底删除」，拿到 428 里的确认卡 */
  async function startPurge() {
    const t = await clockApp(env, { start: '2026-10-27T10:00:00+08:00' });
    open.push(t);
    expect((await t.owner('POST', '/api/members', { name: 'Doomed' })).statusCode).toBe(201);
    expect((await t.owner('DELETE', '/api/members/doomed')).statusCode).toBe(200);
    const first = await t.owner('POST', '/api/members/doomed/purge');
    expect(first.statusCode).toBe(428);
    const ch = first.json().error.confirm as { id: string; stepUrl: string; expiresAt: string };
    const step = (n: 1 | 2) => t.owner('POST', ch.stepUrl, { step: n });
    const purgeWith = (token: string) => t.owner('POST', '/api/members/doomed/purge', { confirmToken: token });
    const stillThere = async () => (await t.owner('GET', '/api/members?deleted=true')).json().members.some((m: { id: string }) => m.id === 'doomed');
    return { t, ch, step, purgeWith, stillThere };
  }

  it('4:59 第二步还能点，拿到令牌后立刻执行成功', async () => {
    const { t, ch, step, purgeWith, stillThere } = await startPurge();
    expect(new Date(ch.expiresAt).getTime() - t.clock.now().getTime()).toBe(5 * 60 * SEC);
    t.clock.advance(4 * 60 * SEC + 56 * SEC); // 4:56 点第一步
    expect((await step(1)).statusCode).toBe(200);
    t.clock.advance(3 * SEC); // 4:59 点第二步（满 3 秒）
    const s2 = await step(2);
    expect(s2.statusCode).toBe(200);
    expect((await purgeWith(s2.json().confirmToken)).statusCode).toBe(204);
    expect(await stillThere()).toBe(false);
  });

  it('5:01 第二步被拒（CONFIRM_EXPIRED），成员没有被彻底删除', async () => {
    const { t, step, stillThere } = await startPurge();
    t.clock.advance(10 * SEC);
    expect((await step(1)).statusCode).toBe(200);
    t.clock.advance(5 * 60 * SEC - 10 * SEC + SEC); // 刚好到 5:01
    const s2 = await step(2);
    expect(s2.statusCode).toBeGreaterThanOrEqual(400);
    expect(s2.json().error.code).toBe('CONFIRM_EXPIRED');
    expect(await stillThere()).toBe(true);
  });

  it('4:59 拿到令牌、5:01 才发原请求：被拒，不执行', async () => {
    const { t, step, purgeWith, stillThere } = await startPurge();
    t.clock.advance(4 * 60 * SEC + 56 * SEC);
    await step(1);
    t.clock.advance(3 * SEC);
    const token = (await step(2)).json().confirmToken as string;
    t.clock.advance(2 * SEC); // 5:01
    const r = await purgeWith(token);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.json().error.code).toBe('CONFIRM_EXPIRED');
    expect(await stillThere()).toBe(true);
  });

  it('过期后重新发起会得到一张新卡（旧卡不能复活）', async () => {
    const { t, ch, step, stillThere } = await startPurge();
    t.clock.advance(5 * 60 * SEC + SEC);
    const again = await t.owner('POST', '/api/members/doomed/purge');
    expect(again.statusCode).toBe(428);
    expect(again.json().error.confirm.id).not.toBe(ch.id);
    expect((await step(1)).json().error?.code ?? 'ok').toBe('CONFIRM_EXPIRED');
    expect(await stillThere()).toBe(true);
  });

  it('跨账号：小号看不到、点不了所有者的确认卡，也不能替它走第二步', async () => {
    const { t, ch, stillThere } = await startPurge();
    t.clock.advance(SEC);
    expect([403, 404]).toContain((await t.xiao('GET', `/api/confirm/${ch.id}`)).statusCode);
    expect([403, 404]).toContain((await t.xiao('POST', ch.stepUrl, { step: 1 })).statusCode);
    // 小号对所有者成员发起彻底删除：同样像不存在
    expect([403, 404]).toContain((await t.xiao('POST', '/api/members/doomed/purge')).statusCode);
    expect(await stillThere()).toBe(true);
    // 所有者自己的这张卡不受影响：第一步照常可点
    expect((await t.owner('POST', ch.stepUrl, { step: 1 })).statusCode).toBe(200);
  });
});
