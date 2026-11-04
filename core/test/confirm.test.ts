import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bindAudit } from '../src/audit/common.js';
import { MemoryAuditLog } from '../src/audit/memory.js';
import { CfAccessVerifier } from '../src/confirm/access.js';
import {
  type ChallengeStore,
  ConfirmService,
  type ConfirmSpec,
  IMPORTANT_MIN_DELAY_MS,
  MemoryChallengeStore,
  PgChallengeStore,
  stableStringify,
} from '../src/confirm/confirm.js';
import type { Db } from '../src/db/db.js';
import { HttpError } from '../src/http/errors.js';
import { challengeOf } from './helpers/confirm.js';
import { dbTargets, fakeClock } from './helpers/db.js';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return `${err.statusCode} ${err.code}`;
    throw err;
  }
  return 'no error';
}

type Factory = { name: string; make: () => Promise<{ store: ChallengeStore; db?: Db }> };
const factories: Factory[] = [
  { name: 'memory', make: async () => ({ store: new MemoryChallengeStore() }) },
  ...dbTargets.map<Factory>((t) => ({
    name: t.name,
    make: async () => {
      const db = await t.open();
      return { store: new PgChallengeStore(db), db };
    },
  })),
];

const owner = { actor: 'owner', canConfirmImportant: true };
const irreversible: ConfirmSpec = { scope: 'x:1', kind: 'irreversible', title: '删除 X', consequences: ['不能恢复'] };

for (const f of factories) {
  describe(`ConfirmService（${f.name}）`, () => {
    const dbs: Db[] = [];
    let clock: ReturnType<typeof fakeClock>;
    let svc: ConfirmService;
    let log: MemoryAuditLog;
    let audit: ReturnType<typeof bindAudit>;
    let iat = 0;

    beforeEach(async () => {
      const { store, db } = await f.make();
      if (db) dbs.push(db);
      clock = fakeClock();
      iat = Math.floor(clock.now().getTime() / 1000);
      const access = { verify: async (jwt: string) => (jwt === 'ok' ? { iat } : null) };
      svc = new ConfirmService(store, { now: clock.now, access, reauthMaxAgeS: 300 });
      log = new MemoryAuditLog(clock.now);
      audit = bindAudit(log, { type: 'owner', id: 'owner' });
    });
    afterAll(async () => {
      for (const db of dbs) await db.close();
    });

    it('普通确认：直接放行，记一条 confirm.normal', async () => {
      await svc.require({ scope: 'n:1', kind: 'normal', title: 't' }, owner, audit);
      expect((await log.query({ action: 'confirm.normal' })).entries).toHaveLength(1);
    });

    it('重要确认必须写后果（编程错误，直接抛）', async () => {
      await expect(svc.require({ scope: 's', kind: 'payment', title: 't' }, owner, audit)).rejects.toThrow(/后果/);
    });

    it('两步 + 3 秒（服务端强制）→ 令牌 → 一次性消费', async () => {
      const ch = await challengeOf(svc.require(irreversible, owner, audit));
      expect(ch).toMatchObject({ nextStep: 1, step2NotBefore: null, minDelayMs: IMPORTANT_MIN_DELAY_MS });
      const s1 = await svc.step(ch.id, 1, { actor: 'owner' }, audit);
      expect(s1.challenge.nextStep).toBe(2);
      expect(new Date(s1.challenge.step2NotBefore as string).getTime() - clock.now().getTime()).toBe(3000);
      // 重复点第一次：幂等，不重置计时
      clock.advance(1000);
      await svc.step(ch.id, 1, { actor: 'owner' }, audit);
      clock.advance(1999);
      expect(await code(svc.step(ch.id, 2, { actor: 'owner' }, audit))).toBe('425 CONFIRM_TOO_EARLY');
      clock.advance(1);
      const s2 = await svc.step(ch.id, 2, { actor: 'owner' }, audit);
      expect(s2.challenge.nextStep).toBe(0);
      const token = s2.confirmToken as string;
      await svc.require(irreversible, { ...owner, confirmToken: token }, audit);
      expect(await code(svc.require(irreversible, { ...owner, confirmToken: token }, audit))).toBe('409 CONFIRM_USED');
    });

    it('别人的 challenge：404；过期：409', async () => {
      const ch = await challengeOf(svc.require(irreversible, owner, audit));
      expect(await code(svc.step(ch.id, 1, { actor: 'operator:x' }, audit))).toBe('404 NOT_FOUND');
      expect(await code(svc.get(ch.id, 'operator:x'))).toBe('404 NOT_FOUND');
      clock.advance(5 * 60 * 1000);
      expect(await code(svc.step(ch.id, 1, { actor: 'owner' }, audit))).toBe('409 CONFIRM_EXPIRED');
    });

    it('令牌绑定请求内容（加盐摘要），内容变了就无效；摘要不含原文', async () => {
      const spec: ConfirmSpec = { scope: 'keys:create', kind: 'irreversible', title: 't', consequences: ['c'], payload: { b: 2, a: 1 } };
      const ch = await challengeOf(svc.require(spec, owner, audit));
      await svc.step(ch.id, 1, { actor: 'owner' }, audit);
      clock.advance(3000);
      const token = (await svc.step(ch.id, 2, { actor: 'owner' }, audit)).confirmToken as string;
      expect(await code(svc.require({ ...spec, payload: { a: 1, b: 3 } }, { ...owner, confirmToken: token }, audit))).toBe('409 CONFIRM_INVALID');
      // 键顺序不同但内容相同：通过
      await svc.require({ ...spec, payload: { a: 1, b: 2 } }, { ...owner, confirmToken: token }, audit);
      expect(stableStringify({ b: 2, a: 1, c: undefined })).toBe('{"a":1,"b":2}');
    });

    it('凭据操作：要新的 Access 令牌；太旧、早于 challenge、缺失都 401；之后补上可以继续', async () => {
      const spec: ConfirmSpec = { scope: 'keys:delete:1', kind: 'credential', title: 't', consequences: ['c'] };
      const ch = await challengeOf(svc.require(spec, owner, audit));
      expect(ch.requiresAccessReauth).toBe(true);
      await svc.step(ch.id, 1, { actor: 'owner' }, audit);
      clock.advance(3000);
      expect(await code(svc.step(ch.id, 2, { actor: 'owner' }, audit))).toBe('401 ACCESS_REAUTH_REQUIRED');
      expect(await code(svc.step(ch.id, 2, { actor: 'owner', accessJwt: 'bad' }, audit))).toBe('401 ACCESS_REAUTH_REQUIRED');
      iat -= 60; // 在 challenge 之前 60 秒验证的：不算「重新」验证
      expect(await code(svc.step(ch.id, 2, { actor: 'owner', accessJwt: 'ok' }, audit))).toBe('401 ACCESS_REAUTH_REQUIRED');
      iat = Math.floor(clock.now().getTime() / 1000);
      const s2 = await svc.step(ch.id, 2, { actor: 'owner', accessJwt: 'ok' }, audit);
      expect(typeof s2.confirmToken).toBe('string');
      const note = (await log.query({ action: 'confirm.step2' })).entries.find((e) => e.result === 'ok')?.note;
      expect(note).toContain('reauth=ok');
    });

    it('凭据操作：重新验证超过配置的时限 → 401', async () => {
      const { store, db } = await f.make();
      if (db) dbs.push(db);
      const short = new ConfirmService(store, { now: clock.now, access: { verify: async () => ({ iat }) }, reauthMaxAgeS: 30 });
      const spec: ConfirmSpec = { scope: 'k', kind: 'credential', title: 't', consequences: ['c'] };
      const ch = await challengeOf(short.require(spec, owner, audit));
      await short.step(ch.id, 1, { actor: 'owner' }, audit);
      clock.advance(31_000);
      expect(await code(short.step(ch.id, 2, { actor: 'owner', accessJwt: 'ok' }, audit))).toBe('401 ACCESS_REAUTH_REQUIRED');
    });

    it('不能确认重要操作的操作者 → 403，不创建 challenge', async () => {
      expect(await code(svc.require(irreversible, { actor: 'operator:x', canConfirmImportant: false }, audit))).toBe('403 FORBIDDEN');
      expect((await log.query({ action: 'confirm.requested' })).entries).toHaveLength(0);
    });
  });
}

describe('CfAccessVerifier（RS256，模拟 Cloudflare 团队公钥）', () => {
  const team = 'aroomo-test.cloudflareaccess.com';
  const aud = ['placeholder', 'aud', 'tag'].join('-');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const clock = fakeClock();
  const nowS = () => Math.floor(clock.now().getTime() / 1000);
  let fetches = 0;
  const v = new CfAccessVerifier({
    teamDomain: team,
    aud,
    now: clock.now,
    fetchCerts: async () => {
      fetches += 1;
      return { keys: [jwk] };
    },
  });

  function jwt(payload: Record<string, unknown>, kid = 'k1', key = privateKey): string {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
  }
  const good = () => ({ aud: [aud], iss: `https://${team}`, iat: nowS(), exp: nowS() + 3600, email: 'owner@example.com' });

  it('合法令牌：返回 iat 和 email；公钥有缓存', async () => {
    expect(await v.verify(jwt(good()))).toEqual({ iat: nowS(), email: 'owner@example.com' });
    await v.verify(jwt(good()));
    expect(fetches).toBe(1);
  });

  it('aud / iss 不对、过期、签名不对、未知 kid、alg 不是 RS256、格式不对 → null', async () => {
    expect(await v.verify(jwt({ ...good(), aud: ['other'] }))).toBeNull();
    expect(await v.verify(jwt({ ...good(), iss: 'https://evil.example' }))).toBeNull();
    expect(await v.verify(jwt({ ...good(), exp: nowS() - 1 }))).toBeNull();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await v.verify(jwt(good(), 'k1', other))).toBeNull();
    expect(await v.verify(jwt(good(), 'unknown'))).toBeNull();
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`;
    expect(await v.verify(none)).toBeNull();
    expect(await v.verify('garbage')).toBeNull();
  });
});
