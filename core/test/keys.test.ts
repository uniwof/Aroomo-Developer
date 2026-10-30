import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hmacToken, MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { LiteLLMAdmin, LiteLLMRejectedError, LiteLLMUnavailableError } from '../src/keys/litellm.js';
import { MemoryKeyStore, PgKeyStore } from '../src/keys/stores.js';
import type { KeyRecord, KeyStore } from '../src/keys/types.js';
import { buildServer } from '../src/server.js';
import { KeysService } from '../src/keys/service.js';
import { ConfirmService, MemoryChallengeStore } from '../src/confirm/confirm.js';
import { dbTargets, fakeClock, OWNER_TOKEN, ownerAuth, TOKEN_SECRET } from './helpers/db.js';
import { MOCK_MASTER_KEY, type MockLiteLLM, startMockLiteLLM } from './helpers/mock-litellm.js';

/** 假 Key 在运行时拼出来（源码里不出现完整的像密钥的字面量）。 */
const fakeKey = (tag: string) => ['placeholder', 'sk', tag, 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
const KEY_A = fakeKey('aaaa');
const KEY_B = fakeKey('bbbb');
const OP = 'placeholder-operator-token-keys-00001';

describe('Key 管理（/api/keys，mock LiteLLM）', () => {
  let mock: MockLiteLLM;
  let app: FastifyInstance;
  let deps: CoreDeps;
  let clock: ReturnType<typeof fakeClock>;
  let logs: string[];
  /** 假的 Cloudflare Access：令牌 'fresh' = 刚刚重新验证；'stale' = 10 分钟前 */
  const access = { verify: async (jwt: string) => (jwt === 'fresh' ? { iat: Math.floor(clock.now().getTime() / 1000) } : jwt === 'stale' ? { iat: Math.floor(clock.now().getTime() / 1000) - 600 } : null) };
  const responses: string[] = [];
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    mock = await startMockLiteLLM();
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await mock.close();
  });

  function build(baseUrl = mock.url, masterKey: string | null = MOCK_MASTER_KEY, timeoutMs = 2000) {
    logs = [];
    clock = fakeClock();
    deps = memoryDeps(clock.now);
    deps.access = access;
    deps.litellm = new LiteLLMAdmin({ baseUrl, masterKey: masterKey ?? undefined, timeoutMs });
    (deps.operatorTokens as MemoryOperatorTokenStore).add({ id: 'op', hmac: hmacToken(TOKEN_SECRET, OP), capabilities: ['keys:read', 'members:read'], revokedAt: null, expiresAt: null });
    app = buildServer(
      loadConfig({ CORE_LOG_LEVEL: 'trace', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_ACCESS_REAUTH: 'required' }),
      deps,
      { logStream: { write: (m: string) => void logs.push(m) } },
    );
    apps.push(app);
  }

  beforeEach(() => {
    mock.mode.add = 'ok';
    mock.mode.del = 'ok';
    mock.mode.models = 'ok';
    mock.deployments.clear();
    mock.calls.length = 0;
    build();
  });

  /** 每个用例结束后检查：响应、日志、审计里都没有完整 Key（末 4 位除外）。 */
  afterEach(async () => {
    const audit = JSON.stringify((await deps.auditLog.query({ limit: 200 })).entries);
    const haystacks = { responses: responses.join('\n'), logs: logs.join('\n'), audit };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const k of [KEY_A, KEY_B]) {
        expect(text.includes(k), `完整 Key 出现在 ${where}`).toBe(false);
        expect(text.includes(k.slice(0, -4)), `Key 前缀出现在 ${where}`).toBe(false);
      }
    }
    responses.length = 0;
  });

  async function raw(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = ownerAuth) {
    const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    responses.push(res.body);
    return res;
  }
  /**
   * 发请求；遇到 428（涉及凭据的重要确认，D63）自动走完：第一次点击 → 3 秒 → 重新验证 Access 后第二次点击 → 带令牌重发。
   */
  async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = ownerAuth) {
    const res = await raw(method, url, payload, headers);
    if (res.statusCode !== 428) return res;
    const ch = res.json().error.confirm;
    expect(ch).toMatchObject({ level: 'important', kind: 'credential', requiresAccessReauth: true });
    expect((await raw('POST', ch.stepUrl, { step: 1 }, headers)).statusCode).toBe(200);
    clock.advance(3000);
    const s2 = await raw('POST', ch.stepUrl, { step: 2 }, { ...headers, 'cf-access-jwt-assertion': 'fresh' });
    expect(s2.statusCode).toBe(200);
    return raw(method, url, { ...(payload ?? {}), confirmToken: s2.json().confirmToken }, headers);
  }
  const create = (over: Record<string, unknown> = {}) =>
    call('POST', '/api/keys', { name: 'OpenAI 主号', sourceUrl: 'https://platform.openai.com/api-keys', apiKey: KEY_A, model: 'openai/gpt-4o-mini', ...over });

  it('新增：写入 LiteLLM（带完整 Key），响应只有末 4 位；本地不存完整 Key', async () => {
    const res = await create({ apiBase: 'https://api.openai.com/v1' });
    expect(res.statusCode).toBe(201);
    const key = res.json().key;
    expect(Object.keys(key).sort()).toEqual(['id', 'last4', 'name', 'sourceUrl', 'status', 'updatedAt']);
    expect(key).toMatchObject({ name: 'OpenAI 主号', last4: 'UV'.padStart(4, 'ST'), status: 'active' });
    expect(key.last4).toBe(KEY_A.slice(-4));
    const [dep] = [...mock.deployments.values()];
    expect(dep?.litellm_params).toMatchObject({ model: 'openai/gpt-4o-mini', api_key: KEY_A, api_base: 'https://api.openai.com/v1' });
    expect(dep?.model_info.aroomo_key_id).toBe(key.id);
    const stored = (await deps.keys.list())[0] as KeyRecord;
    expect(JSON.stringify(stored)).not.toContain(KEY_A);
    expect(mock.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /model/new', 'GET /v1/models', 'GET /model/info']);
    // GET /model/info：读模型事实（候选 / 负责人资格），不读凭据
  });

  it('列表只返回 id、名称、来源网址、末 4 位、状态、更新时间', async () => {
    await create();
    const res = await call('GET', '/api/keys');
    expect(res.statusCode).toBe(200);
    const [k] = res.json().keys;
    expect(Object.keys(k).sort()).toEqual(['id', 'last4', 'name', 'sourceUrl', 'status', 'updatedAt']);
  });

  it('修改：只改名称不碰 LiteLLM；改 Key 整条替换（先新增后删旧）；改接口地址必须同时给 Key', async () => {
    const id = (await create()).json().key.id;
    mock.calls.length = 0;
    const r1 = await call('PATCH', `/api/keys/${id}`, { name: '改个名' });
    expect(r1.json().key.name).toBe('改个名');
    expect(mock.calls).toEqual([]);

    const oldDep = [...mock.deployments.keys()][0];
    const r2 = await call('PATCH', `/api/keys/${id}`, { apiKey: KEY_B });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().key.last4).toBe(KEY_B.slice(-4));
    expect(mock.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /model/new', 'POST /model/delete', 'GET /v1/models', 'GET /model/info']);
    expect(mock.deployments.has(oldDep as string)).toBe(false);
    expect([...mock.deployments.values()][0]?.litellm_params.api_key).toBe(KEY_B);

    const r3 = await call('PATCH', `/api/keys/${id}`, { apiBase: 'https://example.com/v1' });
    expect(r3.statusCode).toBe(400);
    expect(r3.json().error.code).toBe('KEY_REQUIRED');
    expect((await call('PATCH', `/api/keys/00000000-0000-0000-0000-000000000000`, { name: 'x' })).statusCode).toBe(404);
  });

  it('换 Key 时 LiteLLM 拒绝：旧 Key 不受影响', async () => {
    const id = (await create()).json().key.id;
    mock.mode.add = 'reject_echo';
    const r = await call('PATCH', `/api/keys/${id}`, { apiKey: KEY_B });
    expect(r.statusCode).toBe(502);
    expect(mock.deployments.size).toBe(1);
    expect([...mock.deployments.values()][0]?.litellm_params.api_key).toBe(KEY_A);
    expect((await call('GET', '/api/keys')).json().keys[0].last4).toBe(KEY_A.slice(-4));
  });

  it('删除：无令牌 428（凭据类重要确认），不删；确认后删 LiteLLM 部署与本地记录；LiteLLM 已无该部署也能删', async () => {
    const id = (await create()).json().key.id;
    const r1 = await raw('DELETE', `/api/keys/${id}`);
    expect(r1.statusCode).toBe(428);
    expect(r1.json().error.confirm.consequences.length).toBeGreaterThan(0);
    expect(mock.deployments.size).toBe(1);
    // 旧的 confirm: true 已废止（D63）
    expect((await raw('DELETE', `/api/keys/${id}`, { confirm: true })).statusCode).toBe(400);
    expect((await call('DELETE', `/api/keys/${id}`)).statusCode).toBe(204);
    expect(mock.deployments.size).toBe(0);
    expect((await call('GET', '/api/keys')).json().keys).toEqual([]);
    const id2 = (await create()).json().key.id;
    mock.deployments.clear();
    expect((await call('DELETE', `/api/keys/${id2}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/keys/${id2}`)).statusCode).toBe(404);
  });

  it('D73：主人手动新增 / 换 Key 是普通保存（不弹重要确认，记 confirm.normal）', async () => {
    const first = await raw('POST', '/api/keys', { name: 'n', sourceUrl: 'https://x.example/k', apiKey: KEY_A, model: 'openai/gpt-4o-mini' });
    expect(first.statusCode).toBe(201);
    const id = first.json().key.id;
    expect((await raw('PATCH', `/api/keys/${id}`, { apiKey: KEY_B })).statusCode).toBe(200);
    const actions = (await deps.auditLog.query({ limit: 50 })).entries.map((e) => e.action);
    expect(actions.filter((a) => a === 'confirm.normal').length).toBe(2);
    expect(actions).not.toContain('confirm.requested');
  });

  it('D73：智能体 / 操作员发起的新增是重要确认，操作员完成不了（403，D62），Key 不写入', async () => {
    const litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY });
    const svc = new KeysService(new MemoryKeyStore(), litellm, clock.now, new ConfirmService(new MemoryChallengeStore(), { now: clock.now, reauth: 'off' }));
    const audit = async () => undefined;
    await expect(
      svc.create({ name: 'n', sourceUrl: 'https://x.example/k', apiKey: KEY_A, model: 'openai/gpt-4o-mini' }, { actor: 'operator:op', canConfirmImportant: false }, audit),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mock.deployments.size).toBe(0);
  });

  it('删除的第二次点击必须带「刚刚」的 Cloudflare Access 令牌（D63）；令牌绑定请求', async () => {
    const id = (await create()).json().key.id;
    const first = await raw('DELETE', `/api/keys/${id}`);
    expect(first.statusCode).toBe(428);
    const ch = first.json().error.confirm;
    await raw('POST', ch.stepUrl, { step: 1 });
    clock.advance(3000);
    expect((await raw('POST', ch.stepUrl, { step: 2 })).json().error.code).toBe('ACCESS_REAUTH_REQUIRED');
    expect((await raw('POST', ch.stepUrl, { step: 2 }, { ...ownerAuth, 'cf-access-jwt-assertion': 'stale' })).json().error.code).toBe('ACCESS_REAUTH_REQUIRED');
    expect((await raw('POST', ch.stepUrl, { step: 2 }, { ...ownerAuth, 'cf-access-jwt-assertion': 'forged' })).statusCode).toBe(401);
    const ok = await raw('POST', ch.stepUrl, { step: 2 }, { ...ownerAuth, 'cf-access-jwt-assertion': 'fresh' });
    const token = ok.json().confirmToken;
    // 令牌绑定操作范围：拿去删另一个 Key → 409
    const id2 = (await create({ apiKey: KEY_B })).json().key.id;
    expect((await raw('DELETE', `/api/keys/${id2}`, { confirmToken: token })).statusCode).toBe(409);
    expect(mock.deployments.size).toBe(2);
  });

  it('只改名称 / 获取网址不需要确认；没有配置 Cloudflare Access 时删除 Key 503（不悄悄放行）', async () => {
    const id = (await create()).json().key.id;
    expect((await raw('PATCH', `/api/keys/${id}`, { name: 'x', sourceUrl: 'https://y.example/' })).statusCode).toBe(200);
    deps = memoryDeps(clock.now);
    deps.litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY });
    app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN }), deps);
    apps.push(app);
    const created = await raw('POST', '/api/keys', { name: 'n', sourceUrl: 'https://x.example/k', apiKey: KEY_A, model: 'openai/gpt-4o-mini' });
    expect(created.statusCode).toBe(201);
    const r = await raw('DELETE', `/api/keys/${created.json().key.id}`);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('ACCESS_REAUTH_NOT_CONFIGURED');
    // 本地版：CORE_ACCESS_REAUTH=off → 删除仍要两次点击和 3 秒，但不要求 Access
    const app2 = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), deps);
    apps.push(app2);
    const r2 = await app2.inject({ method: 'DELETE', url: `/api/keys/${created.json().key.id}`, headers: ownerAuth });
    expect(r2.statusCode).toBe(428);
    expect(r2.json().error.confirm.requiresAccessReauth).toBe(false);
  });

  it('同步模型列表失败只记状态 sync_failed，不报错', async () => {
    mock.mode.models = 'server_error_echo';
    const r = await create();
    expect(r.statusCode).toBe(201);
    expect(r.json().key.status).toBe('sync_failed');
  });

  it('LiteLLM 回显 Key 的错误：转成通用中文错误，不透传原文（500 → 503，400 → 502）', async () => {
    mock.mode.add = 'server_error_echo';
    const r1 = await create();
    expect(r1.statusCode).toBe(503);
    expect(r1.json().error).toEqual({ code: 'GATEWAY_UNAVAILABLE', message: '模型网关暂时不可用，请稍后再试' });
    mock.mode.add = 'reject_echo';
    const r2 = await create();
    expect(r2.statusCode).toBe(502);
    expect(r2.json().error.code).toBe('GATEWAY_REJECTED');
    expect((await call('GET', '/api/keys')).json().keys).toEqual([]);
  });

  it('LiteLLM 不可用（连接被拒 / 超时 / 未配置管理密钥）→ 503 + 中文提示，不崩溃', async () => {
    build('http://127.0.0.1:1');
    const r1 = await create();
    expect(r1.statusCode).toBe(503);
    expect(r1.json().error.message).toMatch(/暂时不可用/);

    build(mock.url, MOCK_MASTER_KEY, 50);
    mock.mode.add = 'slow';
    const r2 = await create();
    expect(r2.statusCode).toBe(503);
    // 假网关的慢请求在客户端超时后仍会完成并写入部署：等它结束再清掉，避免影响后面的用例
    await new Promise((r) => setTimeout(r, 400));
    mock.deployments.clear();

    build(mock.url, null);
    const r3 = await create();
    expect(r3.statusCode).toBe(503);
    expect(r3.json().error.code).toBe('GATEWAY_NOT_CONFIGURED');
    expect((await call('GET', '/healthz')).statusCode).toBe(200);
  });

  it('请求体校验失败时错误里不带 Key；过短 / 含空格的 Key 拒绝；多余字段 400', async () => {
    const r1 = await create({ model: 'bad model with spaces' });
    expect(r1.statusCode).toBe(400);
    const r2 = await create({ apiKey: 'short' });
    expect(r2.json().error.code).toBe('INVALID_KEY');
    const r3 = await create({ apiKey: `${KEY_A} x` });
    expect(r3.statusCode).toBe(400);
    const r4 = await create({ secret: KEY_B });
    expect(r4.statusCode).toBe(400);
    expect(mock.deployments.size).toBe(0);
  });

  it('trace 日志里记录了请求体，但 apiKey 被替换为 [REDACTED]', async () => {
    await create();
    const bodyLogs = logs.filter((l) => l.includes('request body'));
    expect(bodyLogs.length).toBeGreaterThan(0);
    expect(bodyLogs.join('')).toContain('[REDACTED]');
  });

  it('权限：操作员即使令牌写了 keys:read 也 403（白名单外）；无令牌 401', async () => {
    expect((await call('GET', '/api/keys', undefined, { authorization: `Bearer ${OP}` })).statusCode).toBe(403);
    expect((await call('GET', '/api/keys', undefined, {})).statusCode).toBe(401);
  });

  it('审计：新增 / 替换 / 删除都有记录，只带末 4 位', async () => {
    const id = (await create()).json().key.id;
    await call('PATCH', `/api/keys/${id}`, { apiKey: KEY_B });
    await call('DELETE', `/api/keys/${id}`);
    const e = (await deps.auditLog.query({ limit: 50 })).entries
      .filter((x) => x.action.startsWith('keys.'))
      .map((x) => `${x.action}:${x.result}:${x.note ?? ''}`)
      .reverse();
    expect(e).toEqual([`keys.create:ok:last4=${KEY_A.slice(-4)}`, `keys.replace:ok:last4=${KEY_B.slice(-4)}`, `keys.delete:ok:last4=${KEY_B.slice(-4)}`]);
  });
});

describe('LiteLLMAdmin 客户端', () => {
  let mock: MockLiteLLM;
  beforeAll(async () => {
    mock = await startMockLiteLLM();
  });
  afterAll(() => mock.close());

  it('错误对象里不含 Key，也不含响应原文', async () => {
    mock.mode.add = 'reject_echo';
    const c = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY });
    const err = await c.addDeployment({ id: 'x', modelName: 'm', model: 'openai/m', apiKey: KEY_A }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiteLLMRejectedError);
    expect(JSON.stringify(err) + String(err) + ((err as Error).stack ?? '')).not.toContain(KEY_A);
    mock.mode.add = 'ok';
  });

  it('管理密钥错误 → 拒绝；listDeployments 只取 id 与名称', async () => {
    const bad = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: 'placeholder-wrong-master-key' });
    await expect(bad.listDeployments()).rejects.toBeInstanceOf(LiteLLMRejectedError);
    const c = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY });
    await c.addDeployment({ id: 'dep-1', modelName: 'gpt', model: 'openai/gpt', apiKey: KEY_A });
    expect(await c.listDeployments()).toEqual([{ id: 'dep-1', modelName: 'gpt' }]);
    expect(await c.syncModels()).toEqual(['gpt']);
    await expect(new LiteLLMAdmin({ baseUrl: mock.url, masterKey: undefined }).syncModels()).rejects.toBeInstanceOf(LiteLLMUnavailableError);
  });
});

type Factory = { name: string; make: () => Promise<{ store: KeyStore; db?: Db }> };
const factories: Factory[] = [
  { name: 'memory', make: async () => ({ store: new MemoryKeyStore() }) },
  ...dbTargets.map<Factory>((t) => ({
    name: t.name,
    make: async () => {
      const db = await t.open();
      return { store: new PgKeyStore(db), db };
    },
  })),
];

for (const f of factories) {
  describe(`KeyStore（${f.name}）`, () => {
    it('增删改查；表里没有存 Key 的列', async () => {
      const { store, db } = await f.make();
      const now = new Date('2026-10-27T00:00:00Z');
      const rec: KeyRecord = {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'n',
        sourceUrl: 'https://x.example',
        last4: 'abcd',
        model: 'openai/gpt',
        modelName: 'gpt',
        apiBase: null,
        litellmModelId: 'aroomo-1',
        status: 'active',
        modelsSyncedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await store.insert(rec);
      expect(await store.get(rec.id)).toEqual(rec);
      await store.update({ ...rec, name: 'n2', status: 'sync_failed' });
      expect((await store.list()).map((r) => [r.name, r.status])).toEqual([['n2', 'sync_failed']]);
      expect(await store.delete(rec.id)).toBe(true);
      expect(await store.get(rec.id)).toBeNull();
      if (db) {
        const { rows } = await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_keys' AND table_schema = current_schema()`,
        );
        const cols = rows.map((r) => r.column_name);
        expect(cols).toContain('last4');
        expect(cols.some((c) => /api_key|secret|credential/.test(c))).toBe(false);
        await db.close();
      }
    });
  });
}
