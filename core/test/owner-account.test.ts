/**
 * 必改 1 方案 A（负责人落地方案 v2 阶段 0）：所有者自己的 Core 账号（CORE_OWNER_ACCOUNT_ID）用会话登录时，
 * 数据范围 = 'owner'：成员、用量、对话都用所有者名下的那一套，圆环照常计数；
 * 身份仍是账号：所有者令牌专属的接口照旧 403；小号看不到所有者的成员；配置为空 / 配成非管理员账号 = 不映射。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../src/config.js';
import type { CoreDeps } from '../src/deps.js';
import { LiteLLMAdmin } from '../src/keys/litellm.js';
import { userPrefix } from '../src/keys/prefix.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/users/password.js';
import { seedXiaohao } from '../src/users/seed.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';
import { MOCK_MASTER_KEY, type MockLiteLLM, startMockLiteLLM } from './helpers/mock-litellm.js';
import { XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD, fakePw, twoAccountEnvs } from './helpers/two-accounts.js';

const CHAT_TOKEN = 'placeholder-chat-token-0123456789abcdefgh';
const CSRF = { 'x-aroomo-request': '1' };
const OWNER_ACCOUNT_ID = '4e000000-0000-4000-8000-00000000a001';
const OWNER_EMAIL = 'owner-account@example.test';
const OWNER_PW = fakePw(7);
/** 一个普通（非管理员）账号，固定 id：用来测「配错成家人的 id 也不映射」 */
const FAMILY_ID = '4e000000-0000-4000-8000-00000000f001';
const FAMILY_EMAIL = 'family@example.test';
const FAMILY_PW = fakePw(8);
const enc = new TextEncoder();

const textOf = (body: string) =>
  body
    .split('\n\n')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('data:') && !e.includes('[DONE]'))
    .map((e) => JSON.parse(e.slice(5)) as { type?: string; delta?: string })
    .filter((e) => e.type === 'text-delta')
    .map((e) => e.delta)
    .join('');

interface Env {
  app: FastifyInstance;
  deps: CoreDeps;
  xiaoId: string;
  upstream: string[];
  cookie: (email: string, pw: string) => Promise<string>;
  bearer: (email: string, pw: string) => Promise<Record<string, string>>;
}

describe.each(twoAccountEnvs)('必改 1 方案 A：所有者账号映射到所有者数据 [$name]', (dbEnv) => {
  let mock: MockLiteLLM;
  const opened: FastifyInstance[] = [];

  /** 起一个 Core：所有者账号（管理员，固定 id）+ 小号；envOverrides 控制 CORE_OWNER_ACCOUNT_ID */
  async function start(envOverrides: Record<string, string>): Promise<Env> {
    const clock = fakeClock();
    const deps = await dbEnv.make(clock.now);
    const upstream: string[] = [];
    deps.litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY, timeoutMs: 2000 });
    deps.chatStreamLimits = { perMinute: 1000, concurrent: 1000 };
    deps.chatFetch = (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body)) as { model: string };
      upstream.push(b.model);
      const s = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `我是 ${b.model}` } }] })}\n\n`));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const at = clock.now();
    await deps.users.insertUser({ id: OWNER_ACCOUNT_ID, email: OWNER_EMAIL, displayName: '宝宝', role: 'admin', status: 'active', passwordHash: await hashPassword(OWNER_PW), createdAt: at, updatedAt: at });
    await deps.users.insertUser({ id: FAMILY_ID, email: FAMILY_EMAIL, displayName: '家人', role: 'user', status: 'active', passwordHash: await hashPassword(FAMILY_PW), createdAt: at, updatedAt: at });
    const { userId: xiaoId } = await seedXiaohao(deps.users, { email: XIAOHAO_TEST_EMAIL, password: XIAOHAO_TEST_PASSWORD }, clock.now);
    const app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: 'silent',
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_ACCESS_REAUTH: 'off',
        CORE_CHAT_TOKEN: CHAT_TOKEN,
        LITELLM_BASE_URL: mock.url,
        LITELLM_MASTER_KEY: MOCK_MASTER_KEY,
        ...envOverrides,
      }),
      deps,
    );
    opened.push(app);
    const login = async (email: string, password: string, cookie: boolean) => {
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, cookie } });
      expect(r.statusCode).toBe(200);
      return r;
    };
    const env: Env = {
      app,
      deps,
      xiaoId,
      upstream,
      cookie: async (e, p) => String((await login(e, p, true)).headers['set-cookie']).split(';')[0]!,
      bearer: async (e, p) => ({ authorization: `Bearer ${(await login(e, p, false)).json().token as string}` }),
    };
    // 所有者名下（所有者令牌）一个成员；小号自己一个成员
    expect((await app.inject({ method: 'POST', url: '/api/members', headers: ownerAuth, payload: { name: 'OwnerBot' } })).statusCode).toBeLessThan(300);
    const xb = await env.bearer(XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD);
    expect((await app.inject({ method: 'POST', url: '/api/members', headers: xb, payload: { name: 'XiaoBot' } })).statusCode).toBeLessThan(300);
    return env;
  }

  const names = (r: { json: () => unknown }) => ((r.json() as { members: Array<{ name: string }> }).members ?? []).map((m) => m.name);
  const chat = (e: Env, cookie: string, model: string) =>
    e.app.inject({ method: 'POST', url: '/api/chat/stream', headers: { cookie, ...CSRF }, payload: { model, messages: [{ role: 'user', content: 'hi' }] } });
  const ownerUsage = async (e: Env, headers: Record<string, string>) => {
    const r = await e.app.inject({ method: 'GET', url: '/api/usage', headers });
    expect(r.statusCode).toBe(200);
    const rows = (r.json() as { members: Array<{ name: string; today: { requests: number } }> }).members;
    return rows.find((m) => m.name === 'OwnerBot')?.today.requests ?? -1;
  };

  beforeAll(async () => {
    mock = await startMockLiteLLM();
  });
  afterAll(async () => {
    for (const a of opened) await a.close();
    await mock.close();
  });

  it('配置了：所有者账号用 Cookie 会话登录，看到的是所有者名下的成员，看不到小号的', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const ck = await e.cookie(OWNER_EMAIL, OWNER_PW);
    const viaCookie = await e.app.inject({ method: 'GET', url: '/api/members', headers: { cookie: ck } });
    expect(viaCookie.statusCode).toBe(200);
    expect(names(viaCookie)).toContain('OwnerBot');
    expect(names(viaCookie)).not.toContain('XiaoBot');
  });

  it('负责人必改 1：同一个账号的会话令牌放在 Bearer 头里 → 不映射，只看到自己账号的数据（空）', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const viaBearer = await e.app.inject({ method: 'GET', url: '/api/members', headers: await e.bearer(OWNER_EMAIL, OWNER_PW) });
    expect(viaBearer.statusCode).toBe(200);
    expect(names(viaBearer)).toEqual([]);
  });

  it('负责人必改 2：映射后的审计记录写明 scope=owner(mapped) 和账号 id（操作者仍是这个账号）', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const ck = await e.cookie(OWNER_EMAIL, OWNER_PW);
    const r = await e.app.inject({ method: 'POST', url: '/api/members', headers: { cookie: ck, ...CSRF }, payload: { name: 'ViaOwnerAccount' } });
    expect(r.statusCode).toBeLessThan(300);
    expect(names(await e.app.inject({ method: 'GET', url: '/api/members', headers: ownerAuth }))).toContain('ViaOwnerAccount');
    const q = await e.app.inject({ method: 'GET', url: `/api/audit?actorType=user&actorId=${OWNER_ACCOUNT_ID}`, headers: ownerAuth });
    expect(q.statusCode).toBe(200);
    const entries = (q.json() as { entries: Array<{ actor: { type: string; id: string }; action: string; note?: string }> }).entries;
    const create = entries.find((x) => x.action.startsWith('members.'));
    expect(create).toBeDefined();
    expect(create!.actor).toEqual({ type: 'user', id: OWNER_ACCOUNT_ID });
    expect(create!.note ?? '').toContain('scope=owner(mapped)');
    expect(create!.note ?? '').toContain(`account=${OWNER_ACCOUNT_ID}`);
    // 小号（没映射）的审计不带这个标记
    const xb = await e.bearer(XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD);
    await e.app.inject({ method: 'POST', url: '/api/members', headers: xb, payload: { name: 'XiaoBot2' } });
    const xq = await e.app.inject({ method: 'GET', url: `/api/audit?actorType=user&actorId=${e.xiaoId}`, headers: ownerAuth });
    for (const x of (xq.json() as { entries: Array<{ note?: string }> }).entries) expect(x.note ?? '').not.toContain('scope=owner');
  });

  it('配置了：所有者账号对话用所有者的成员（上游名不带账号前缀），圆环计数 +1；所有者令牌看到的是同一个数', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const ck = await e.cookie(OWNER_EMAIL, OWNER_PW);
    const before = await ownerUsage(e, ownerAuth);
    const r = await chat(e, ck, 'aroomo/ownerbot');
    expect(r.statusCode).toBe(200);
    expect(textOf(r.body)).toContain('我是 OwnerBot');
    expect(e.upstream).toEqual(['OwnerBot']);
    expect(e.upstream.some((m) => m.startsWith('u'))).toBe(false);
    expect(await ownerUsage(e, ownerAuth)).toBe(before + 1);
    expect(await ownerUsage(e, { cookie: ck })).toBe(before + 1);
  });

  it('配置了：小号照旧叫不到所有者的成员、成员列表里也没有；所有者账号叫不到小号的成员', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const xc = await e.cookie(XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD);
    const r = await chat(e, xc, 'aroomo/ownerbot');
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('我是 OwnerBot');
    expect(e.upstream).toEqual([]);
    const list = await e.app.inject({ method: 'GET', url: '/api/members', headers: { cookie: xc } });
    expect(names(list)).toEqual(['XiaoBot']);
    const oc = await e.cookie(OWNER_EMAIL, OWNER_PW);
    const o = await chat(e, oc, 'aroomo/xiaobot');
    expect(o.body).not.toContain('XiaoBot');
    expect(e.upstream).toEqual([]);
    // 小号自己的对话照旧带本人前缀
    await chat(e, xc, 'aroomo/xiaobot');
    expect(e.upstream).toEqual([`${userPrefix(e.xiaoId)}/XiaoBot`]);
  });

  it('身份仍是账号：所有者令牌专属的接口（审计）照旧 403；/api/auth/me 仍是她自己的账号', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const ck = await e.cookie(OWNER_EMAIL, OWNER_PW);
    expect((await e.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: ck } })).statusCode).toBe(403);
    const me = await e.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ck } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ kind: 'user', user: { id: OWNER_ACCOUNT_ID } });
  });

  it('#295：/api/auth/me 回 ownerAccount——所有者账号（Cookie 会话）true；第二个管理员、家人、Bearer 头、没配置都是 false', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID });
    const SECOND_ADMIN = '4e000000-0000-4000-8000-00000000a002';
    const at = new Date();
    await e.deps.users.insertUser({ id: SECOND_ADMIN, email: 'admin2@example.test', displayName: '另一个管理员', role: 'admin', status: 'active', passwordHash: await hashPassword(fakePw(9)), createdAt: at, updatedAt: at });
    const me = async (headers: Record<string, string>) => {
      const r = await e.app.inject({ method: 'GET', url: '/api/auth/me', headers });
      expect(r.statusCode).toBe(200);
      return r.json() as { kind: string; ownerAccount?: unknown; user?: { id: string } };
    };
    expect(await me({ cookie: await e.cookie(OWNER_EMAIL, OWNER_PW) })).toMatchObject({ kind: 'user', ownerAccount: true, user: { id: OWNER_ACCOUNT_ID } });
    expect(await me({ cookie: await e.cookie('admin2@example.test', fakePw(9)) })).toMatchObject({ kind: 'user', ownerAccount: false, user: { id: SECOND_ADMIN } });
    expect(await me({ cookie: await e.cookie(FAMILY_EMAIL, FAMILY_PW) })).toMatchObject({ kind: 'user', ownerAccount: false });
    expect(await me(await e.bearer(OWNER_EMAIL, OWNER_PW))).toMatchObject({ kind: 'user', ownerAccount: false });
    const off = await start({});
    const r = await off.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: await off.cookie(OWNER_EMAIL, OWNER_PW) } });
    expect(r.json()).toMatchObject({ kind: 'user', ownerAccount: false });
  });

  it('没配置：行为不变——所有者账号只看到自己账号的数据（空），对话找不到所有者的成员', async () => {
    const e = await start({});
    const ck = await e.cookie(OWNER_EMAIL, OWNER_PW);
    expect(names(await e.app.inject({ method: 'GET', url: '/api/members', headers: { cookie: ck } }))).toEqual([]);
    const r = await chat(e, ck, 'aroomo/ownerbot');
    expect(r.body).not.toContain('我是 OwnerBot');
    expect(e.upstream).toEqual([]);
  });

  it('配成非管理员账号（例如配错成家人的 id）：不映射，家人只看到自己的（空），对话叫不到所有者的成员', async () => {
    const e = await start({ CORE_OWNER_ACCOUNT_ID: FAMILY_ID });
    const fc = await e.cookie(FAMILY_EMAIL, FAMILY_PW);
    expect(names(await e.app.inject({ method: 'GET', url: '/api/members', headers: { cookie: fc } }))).toEqual([]);
    const r = await chat(e, fc, 'aroomo/ownerbot');
    expect(r.body).not.toContain('我是 OwnerBot');
    expect(e.upstream).toEqual([]);
  });
});

describe.each(twoAccountEnvs)('负责人必改 3：启动检查——配置的账号必须存在、是管理员、没停用，否则整个进程不映射并告警 [$name]', (dbEnv) => {
  const opened: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of opened) await a.close();
  });

  async function boot(configured: string, seed: { role: 'admin' | 'user'; status: 'active' | 'disabled' } | null) {
    const clock = fakeClock();
    const deps = await dbEnv.make(clock.now);
    const at = clock.now();
    if (seed) await deps.users.insertUser({ id: OWNER_ACCOUNT_ID, email: OWNER_EMAIL, displayName: '宝宝', role: seed.role, status: seed.status, passwordHash: await hashPassword(OWNER_PW), createdAt: at, updatedAt: at });
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', CORE_OWNER_ACCOUNT_ID: configured }), deps);
    opened.push(app);
    const warn = vi.spyOn(app.log, 'warn');
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/members', headers: ownerAuth, payload: { name: 'OwnerBot' } })).statusCode).toBeLessThan(300);
    const warned = warn.mock.calls.some((c) => JSON.stringify(c).includes('CORE_OWNER_ACCOUNT_ID'));
    const cookie = async () => {
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: OWNER_EMAIL, password: OWNER_PW, cookie: true } });
      expect(r.statusCode).toBe(200);
      return String(r.headers['set-cookie']).split(';')[0]!;
    };
    const membersVia = async (ck: string) => names(await app.inject({ method: 'GET', url: '/api/members', headers: { cookie: ck } }));
    return { app, deps, warned, cookie, membersVia, at };
  }
  const names = (r: { json: () => unknown }) => ((r.json() as { members: Array<{ name: string }> }).members ?? []).map((m) => m.name);

  it('账号存在、是管理员、没停用：不告警，Cookie 登录映射', async () => {
    const b = await boot(OWNER_ACCOUNT_ID, { role: 'admin', status: 'active' });
    expect(b.warned).toBe(false);
    expect(await b.membersVia(await b.cookie())).toContain('OwnerBot');
  });

  it('账号不存在：告警', async () => {
    const b = await boot(OWNER_ACCOUNT_ID, null);
    expect(b.warned).toBe(true);
  });

  it('账号已停用：告警', async () => {
    const b = await boot(OWNER_ACCOUNT_ID, { role: 'admin', status: 'disabled' });
    expect(b.warned).toBe(true);
  });

  it('账号不是管理员：告警；之后就算被改成管理员，这个进程也不映射（要重启重新检查）', async () => {
    const b = await boot(OWNER_ACCOUNT_ID, { role: 'user', status: 'active' });
    expect(b.warned).toBe(true);
    await b.deps.users.updateUser(OWNER_ACCOUNT_ID, { role: 'admin' }, b.at);
    expect(await b.membersVia(await b.cookie())).toEqual([]);
  });
});

describe('CORE_OWNER_ACCOUNT_ID 配置校验', () => {
  const base = { CORE_LOG_LEVEL: 'silent' };
  it('不设 = undefined；UUID 接受并转小写；其他一律拒绝（含 owner、邮箱、SQL、不带横线的 hex）', () => {
    expect(loadConfig(base).ownerAccountId).toBeUndefined();
    expect(loadConfig({ ...base, CORE_OWNER_ACCOUNT_ID: OWNER_ACCOUNT_ID.toUpperCase() }).ownerAccountId).toBe(OWNER_ACCOUNT_ID);
    for (const bad of ['owner', 'tifni023@gmail.com', "x' or '1'='1", '4e76f87fa6794f4f96d9c5fabc24facf']) {
      expect(() => loadConfig({ ...base, CORE_OWNER_ACCOUNT_ID: bad })).toThrow(ConfigError);
    }
  });
});
