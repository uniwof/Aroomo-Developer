/** #346 负责人第 1 轮 M1 / M2 / M4：家人本人确认要本人密码（与登录共用锁定）、只有账号会话能走、反方向与旁路。 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hmacToken, type MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { CLIENT_SCOPES, EXECUTOR_SCOPES } from '../src/clients/types.js';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, TOKEN_SECRET, appRoleDbTargets, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const VAULT_KEY = randomBytes(32).toString('base64');
const PLAIN = 'family-plain-346';
const OP = 'placeholder-op-346';

const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...[...dbTargets, ...appRoleDbTargets].map((t) => ({ name: t.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await t.open(), now) })),
];

describe.each(envs)('#346 家人本人确认（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup(reauth: 'off' | 'required' = 'off') {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    if (env.name === 'memory')
      (deps.operatorTokens as MemoryOperatorTokenStore).add({ id: 'op', hmac: hmacToken(TOKEN_SECRET, OP), capabilities: ['inbox:read', 'members:read'], revokedAt: null, expiresAt: null });
    const app = buildServer(
      loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_ACCESS_REAUTH: reauth, VAULT_KEY }),
      deps,
    );
    apps.push(app);
    const call = (headers: Record<string, string>) => (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const inv = await owner('POST', '/api/users/invites', { email: 'xiao@example.com' });
    const acc = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
    const xiaoId = acc.json().user.id as string;
    const xiao = call({ authorization: `Bearer ${acc.json().token}` });
    const item = (await xiao('POST', '/api/vault', { name: 'Mail', kind: 'password', value: PLAIN })).json().secret.id as string;
    /** 家人发起 reveal → 428 → 第一次点击 → 3 秒后返回 stepUrl */
    const card = async (method: 'POST' | 'DELETE' = 'POST') => {
      const first = await xiao(method, method === 'POST' ? `/api/vault/${item}/reveal` : `/api/vault/${item}`, {});
      expect(first.statusCode, first.body).toBe(428);
      const ch = first.json().error.confirm as { id: string; stepUrl: string; requiresPassword?: true };
      expect((await xiao('POST', ch.stepUrl, { step: 1 })).statusCode).toBe(200);
      clock.advance(3500);
      return ch;
    };
    const audits = async () => (await deps.auditLog.query({ limit: 500 })).entries;
    return { app, deps, clock, owner, xiao, xiaoId, item, card, audits, call };
  }

  it('M1：第二步没带密码 401 PASSWORD_REQUIRED；错密码 401 BAD_CREDENTIALS 不发令牌；对的密码才发；密码不进审计', async () => {
    const t = await setup();
    const ch = await t.card();
    expect(ch.requiresPassword).toBe(true);
    const none = await t.xiao('POST', ch.stepUrl, { step: 2 });
    expect([none.statusCode, none.json().error.code]).toEqual([401, 'PASSWORD_REQUIRED']);
    const bad = await t.xiao('POST', ch.stepUrl, { step: 2, password: 'wrong-password-xx' });
    expect([bad.statusCode, bad.json().error.code]).toEqual([401, 'BAD_CREDENTIALS']);
    expect(bad.json().confirmToken).toBeUndefined();
    const ok = await t.xiao('POST', ch.stepUrl, { step: 2, password: PW });
    expect(ok.statusCode, ok.body).toBe(200);
    const done = await t.xiao('POST', `/api/vault/${t.item}/reveal`, { confirmToken: ok.json().confirmToken });
    expect(done.json().value).toBe(PLAIN);
    const dump = JSON.stringify(await t.audits());
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain('wrong-password-xx');
    const acts = (await t.audits()).map((e) => `${e.action}:${e.result}:${e.note ?? ''}`);
    expect(acts).toContain('confirm.step2:failed:PASSWORD_REQUIRED');
    expect(acts).toContain('confirm.step2:failed:BAD_CREDENTIALS');
    expect(acts.some((a) => a.startsWith('confirm.step2:ok:') && a.endsWith('reauth=password'))).toBe(true);
  });

  it('M1：连续 5 次错密码后锁定（429，正确密码也不行）；和登录共用同一份计数（登录也被锁）', async () => {
    const t = await setup();
    const ch = await t.card();
    for (let i = 0; i < 5; i++) expect((await t.xiao('POST', ch.stepUrl, { step: 2, password: `wrong-${i}-xxxxxx` })).statusCode).toBe(401);
    const locked = await t.xiao('POST', ch.stepUrl, { step: 2, password: PW });
    expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'TOO_MANY_ATTEMPTS']);
    const login = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'xiao@example.com', password: PW } });
    expect(login.statusCode).toBe(429);
    // 15 分钟后解锁
    t.clock.advance(16 * 60_000);
    const ch2 = await t.card();
    expect((await t.xiao('POST', ch2.stepUrl, { step: 2, password: PW })).statusCode).toBe(200);
  });

  it('M1：reauth=required（没配 Access）：家人凭本人密码能完成；主人仍被 Access 卡住（503），不受影响', async () => {
    const t = await setup('required');
    const ch = await t.card();
    const ok = await t.xiao('POST', ch.stepUrl, { step: 2, password: PW });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await t.xiao('POST', `/api/vault/${t.item}/reveal`, { confirmToken: ok.json().confirmToken })).json().value).toBe(PLAIN);
    const oid = (await t.owner('POST', '/api/vault', { name: 'O', kind: 'password', value: 'owner-pw-346' })).json().secret.id;
    const o = await t.owner('POST', `/api/vault/${oid}/reveal`, {});
    expect([o.statusCode, o.json().error.code]).toEqual([503, 'ACCESS_REAUTH_NOT_CONFIGURED']);
  });

  it('M2：家人和主人的 arc_ 令牌、设备令牌、操作员令牌打 confirm / vault 四个接口：一律 403，只记 auth.denied，卡没被动', async () => {
    const t = await setup();
    const ch = await t.card();
    const allButExecutor = CLIENT_SCOPES.filter((s) => !EXECUTOR_SCOPES.includes(s));
    const mk = async (who: typeof t.owner, scopes: readonly string[]) => {
      const r = await who('POST', '/api/clients', { name: 'c', scopes });
      expect(r.statusCode, r.body).toBe(201);
      return { authorization: `Bearer ${r.json().token as string}` };
    };
    const callers: [string, Record<string, string>][] = [
      ['家人的 arc_', await mk(t.xiao, allButExecutor)],
      ['主人的 arc_', await mk(t.owner, allButExecutor)],
      ['家人的设备令牌', await mk(t.xiao, EXECUTOR_SCOPES)],
      ...(env.name === 'memory' ? ([['操作员', { authorization: `Bearer ${OP}` }]] as [string, Record<string, string>][]) : []),
    ];
    for (const [name, h] of callers) {
      const c = t.call(h);
      const before = new Set((await t.audits()).map((e) => e.id));
      const got = [
        (await c('GET', `/api/confirm/${ch.id}`)).statusCode,
        (await c('POST', ch.stepUrl, { step: 2, password: PW })).statusCode,
        (await c('POST', `/api/vault/${t.item}/reveal`, {})).statusCode,
        (await c('DELETE', `/api/vault/${t.item}`, {})).statusCode,
      ];
      expect([name, got]).toEqual([name, [403, 403, 403, 403]]);
      const fresh = (await t.audits()).filter((e) => !before.has(e.id));
      expect([name, fresh.map((e) => `${e.action}:${e.result}`)]).toEqual([name, Array(4).fill('auth.denied:denied')]);
    }
    // 卡还在、没被用：家人本人照样能完成
    const ok = await t.xiao('POST', ch.stepUrl, { step: 2, password: PW });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('M4：主人令牌看 / 点家人的卡 404；家人确认不往主人收件箱放东西；consumed / reveal / delete 的 actor 都是家人本人', async () => {
    const t = await setup();
    const inboxBefore = (await t.owner('GET', '/api/inbox')).json();
    const ch = await t.card();
    expect((await t.owner('GET', `/api/confirm/${ch.id}`)).statusCode).toBe(404);
    expect((await t.owner('POST', ch.stepUrl, { step: 1 })).statusCode).toBe(404);
    const tok = (await t.xiao('POST', ch.stepUrl, { step: 2, password: PW })).json().confirmToken as string;
    expect((await t.xiao('POST', `/api/vault/${t.item}/reveal`, { confirmToken: tok })).statusCode).toBe(200);
    const ch2 = await t.card('DELETE');
    const tok2 = (await t.xiao('POST', ch2.stepUrl, { step: 2, password: PW })).json().confirmToken as string;
    expect((await t.xiao('DELETE', `/api/vault/${t.item}`, { confirmToken: tok2 })).statusCode).toBe(204);
    expect((await t.owner('GET', '/api/inbox')).json()).toEqual(inboxBefore);
    const want = { type: 'user', id: t.xiaoId };
    const by = async (action: string) => (await t.audits()).filter((e) => e.action === action && e.result === 'ok').map((e) => e.actor);
    for (const a of ['confirm.consumed', 'vault.reveal', 'vault.delete']) {
      const actors = await by(a);
      expect([a, actors.length]).toEqual([a, a === 'confirm.consumed' ? 2 : 1]);
      for (const x of actors) expect([a, x]).toEqual([a, want]);
    }
  });
});
