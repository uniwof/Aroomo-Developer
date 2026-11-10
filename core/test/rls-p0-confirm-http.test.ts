/**
 * #345 负责人必改 M2：确认卡 HTTP 级端到端（真 PG / PGlite，都以「非超级用户、非表所有者」的应用角色连接，RLS 真的生效）。
 *
 * 主人走完两步拿到确认令牌（查看保险箱明文，credential 级），然后把这个令牌交给：
 *   - 家人会话（小号 Bearer 会话）；
 *   - 家人自己的 arc_ 客户端令牌；
 *   - 主人自己的 arc_ 客户端令牌；
 * 每个身份都试两种用法：原样重放主人的请求（主人的条目 id），以及拿去确认自己名下的同类操作。全部被拒；
 * 数据库里这张卡 used_at 仍为 NULL；审计里有拒绝记录、没有 confirm.consumed。最后主人自己用这个令牌成功（正向对照）。
 *
 * 注：在 HTTP 层，家人账号和 arc_ 客户端令牌都没有 confirm:important（principalCan 对 user / client 恒为 false，D62），
 * 所以它们在 ConfirmService.require 的第一道「能不能做重要确认」就被拒（403 + confirm.denied），走不到按令牌查卡那一步。
 * 「令牌查到了、但操作者不对」（409 + confirm.rejected）这条路径在 HTTP 层没有身份能走到，
 * 由 test/rls-p0.test.ts 的服务层用例覆盖（给攻击方 canConfirmImportant=true，证明 RLS 和应用层 actor 校验各自都拦得住）。
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_SCOPES } from '../src/clients/types.js';
import { grantAppRole } from '../src/db/app-role.js';
import { createPgDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { systemScoped } from '../src/db/scope.js';
import { pgDeps } from '../src/deps.js';
import { openPglite } from './helpers/db.js';
import { type Inject, type TwoAccounts, twoAccounts } from './helpers/two-accounts.js';

const REQUIRE_REAL_PG = process.env.CI === 'true' || process.env.CI === '1' || process.env.AROOMO_REQUIRE_REAL_PG === '1';
const PG_URL = process.env.CORE_TEST_DATABASE_URL;

/** 生产同款授权（grantAppRole）：NOLOGIN、非超级用户、不能绕过 RLS、不是表所有者（D206）。迁移以表所有者身份做完再切过去 */
const APP_ROLE = 'aroomo_m2_app_test';
const CREATE_APP_ROLE = `DO $$ BEGIN CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`;
const targets: { name: string; open(): Promise<Db> }[] = [
  {
    name: 'pglite',
    async open() {
      const db = await openPglite();
      await db.exec(CREATE_APP_ROLE);
      await grantAppRole(db, APP_ROLE);
      await db.exec(`SET ROLE ${APP_ROLE}`);
      return db;
    },
  },
  ...(PG_URL
    ? [
        {
          name: 'postgres',
          async open() {
            const schema = `m2_${randomBytes(6).toString('hex')}`;
            const admin = createPgDb(PG_URL, { max: 1 });
            await admin.exec(`CREATE SCHEMA ${schema}`);
            await admin.close();
            const owner = createPgDb(PG_URL, { schema, max: 1 });
            try {
              await migrate(owner);
              await owner.exec(CREATE_APP_ROLE);
              await grantAppRole(owner, APP_ROLE);
            } finally {
              await owner.close();
            }
            return createPgDb(PG_URL, { schema, max: 4, role: APP_ROLE });
          },
        },
      ]
    : []),
];

describe('M2 真 PG 必须在场（CI）', () => {
  it.runIf(REQUIRE_REAL_PG)('CI 下 rlsTargets 必须含真 PostgreSQL（不是跳过）', () => {
    expect(targets.map((t) => t.name)).toContain('postgres');
  });
  if (!REQUIRE_REAL_PG && !PG_URL) it.skip('本地没配 CORE_TEST_DATABASE_URL：只跑 PGlite（CI 里会失败）', () => {});
});

describe.each(targets)('M2 确认令牌换身份使用（$name，应用角色）', (target) => {
  let t: TwoAccounts;
  let db: Db;
  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
  let ownerClient: Record<string, string>;
  let xiaoClient: Record<string, string>;
  let ownerVault: string;
  let xiaoVault: string;
  let challengeId: string;
  let token: string;

  const call = (h: Record<string, string> | 'owner' | 'xiao', method: 'POST' | 'GET', url: string, payload?: object): Promise<Inject> =>
    h === 'owner' ? t.owner(method, url, payload) : h === 'xiao' ? t.xiao(method, url, payload) : t.app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
  const usedAt = async () =>
    (await systemScoped(db).query<{ used_at: unknown; user_id: string }>('SELECT used_at, user_id FROM confirm_challenges WHERE id = $1', [challengeId])).rows[0];
  const auditActions = async () => (await t.deps.auditLog.query({ limit: 500 })).entries.filter((e) => e.target.type === 'confirm').map((e) => `${e.action}:${e.result}:${e.note ?? ''}`);

  beforeAll(async () => {
    t = await twoAccounts(
      {
        name: target.name,
        make: async (now) => {
          db = await target.open();
          return pgDeps(db, now);
        },
      },
      { CORE_JOBS: 'off', VAULT_KEY: randomBytes(32).toString('base64') },
    );
    const oc = await t.owner('POST', '/api/clients', { name: 'owner all', scopes: [...CLIENT_SCOPES] });
    expect(oc.statusCode, oc.body).toBe(201);
    ownerClient = bearer(oc.json().token as string);
    const xc = await t.xiao('POST', '/api/clients', { name: 'xiao all', scopes: [...CLIENT_SCOPES] });
    expect(xc.statusCode, xc.body).toBe(201);
    xiaoClient = bearer(xc.json().token as string);
    ownerVault = (await t.owner('POST', '/api/vault', { name: 'ownerv', kind: 'password', value: 'owner-plain-m2' })).json().secret.id as string;
    xiaoVault = (await t.xiao('POST', '/api/vault', { name: 'xiaov', kind: 'password', value: 'xiao-plain-m2' })).json().secret.id as string;
    // 主人：第一次调用 → 428 + 确认卡；点两次（间隔 ≥3 秒）→ 一次性确认令牌
    const r = await t.owner('POST', `/api/vault/${ownerVault}/reveal`, {});
    expect(r.statusCode, r.body).toBe(428);
    challengeId = /\/api\/confirm\/([^/]+)\/steps/.exec(r.json().error.confirm.stepUrl as string)![1]!;
    expect((await t.owner('POST', `/api/confirm/${challengeId}/steps`, { step: 1 })).statusCode).toBe(200);
    t.clock.advance(3500);
    const s2 = await t.owner('POST', `/api/confirm/${challengeId}/steps`, { step: 2 });
    expect(s2.statusCode, s2.body).toBe(200);
    token = s2.json().confirmToken as string;
    expect(token).toBeTruthy();
    expect(await usedAt()).toEqual({ used_at: null, user_id: 'owner' });
  });
  afterAll(async () => {
    await t?.close();
  });

  /** 每次攻击新增的审计（按 id 去重，钉具体动作和结果） */
  const newAudit = async (before: Set<string>) =>
    (await t.deps.auditLog.query({ limit: 500 })).entries.filter((e) => !before.has(e.id)).map((e) => `${e.action}:${e.result}:${e.note ?? ''}`).sort();
  const auditIds = async () => new Set((await t.deps.auditLog.query({ limit: 500 })).entries.map((e) => e.id));
  const ROUTE_DENIED = 'auth.denied:denied:POST 客户端令牌没有这个范围';
  const attackers = [
    // 家人会话：重放主人的请求 → 条目不在自己名下，404（和不存在一样）；拿去确认自己的条目 → 家人没有 confirm:important，403 + confirm.denied
    { name: '家人会话', who: () => 'xiao' as const, replay: [404, 'NOT_FOUND'], own: [403, 'FORBIDDEN'], audit: ['confirm.denied:denied:credential'] },
    // arc_ 客户端令牌（家人的 / 主人自己的）：保险箱路由不收客户端令牌，路由层 403 + auth.denied，到不了确认服务
    { name: '家人的 arc_ 令牌', who: () => xiaoClient, replay: [403, 'FORBIDDEN'], own: [403, 'FORBIDDEN'], audit: [ROUTE_DENIED, ROUTE_DENIED] },
    { name: '主人自己的 arc_ 令牌', who: () => ownerClient, replay: [403, 'FORBIDDEN'], own: [403, 'FORBIDDEN'], audit: [ROUTE_DENIED, ROUTE_DENIED] },
  ] as const;

  it.each(attackers)('$name 拿主人的确认令牌：重放主人的请求、确认自己的操作都被拒，卡没被用掉', async ({ who, replay: rp, own: ow, audit }) => {
    const before = await auditIds();
    const replay = await call(who(), 'POST', `/api/vault/${ownerVault}/reveal`, { confirmToken: token });
    const own = await call(who(), 'POST', `/api/vault/${xiaoVault}/reveal`, { confirmToken: token });
    expect([replay.statusCode, replay.json().error.code], replay.body).toEqual(rp);
    expect([own.statusCode, own.json().error.code], own.body).toEqual(ow);
    for (const res of [replay, own]) {
      expect(res.body).not.toContain('owner-plain-m2');
      expect(res.body).not.toContain('xiao-plain-m2');
    }
    expect(await newAudit(before)).toEqual([...audit].sort());
    expect((await usedAt())?.used_at).toBeNull();
  });

  it('三种攻击之后：审计里有拒绝记录，没有任何 confirm.consumed；卡的 used_at 仍为 NULL、仍归主人', async () => {
    const acts = await auditActions();
    expect(acts.filter((a) => a.startsWith('confirm.denied:denied')).length).toBe(1);
    expect(acts.some((a) => a.startsWith('confirm.consumed'))).toBe(false);
    expect(await usedAt()).toEqual({ used_at: null, user_id: 'owner' });
  });

  it('正向对照：主人自己用这个令牌成功，之后卡 used_at 有值、审计有 confirm.consumed；再用一次被拒', async () => {
    const ok = await t.owner('POST', `/api/vault/${ownerVault}/reveal`, { confirmToken: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().value).toBe('owner-plain-m2');
    expect((await usedAt())?.used_at).not.toBeNull();
    expect((await auditActions()).some((a) => a.startsWith('confirm.consumed:ok'))).toBe(true);
    const again = await t.owner('POST', `/api/vault/${ownerVault}/reveal`, { confirmToken: token });
    expect(again.statusCode).toBe(409);
    expect((await auditActions()).some((a) => a.startsWith('confirm.rejected:failed:CONFIRM_USED'))).toBe(true);
  });
});
