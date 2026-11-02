import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { dbTargets } from './helpers/db.js';
import { LiteLLMAdmin } from '../src/keys/litellm.js';
import { userPrefix } from '../src/keys/prefix.js';
import { MOCK_MASTER_KEY, type MockLiteLLM, startMockLiteLLM } from './helpers/mock-litellm.js';
import { expectDenied, expectSameAsMissing, twoAccounts, type TwoAccounts } from './helpers/two-accounts.js';

/** #179：账号的 Key 带 u<id> 前缀；/v1 按令牌主人路由；小号看不出所有者存在 */
const fakeKey = (tag: string) => ['placeholder', 'sk', tag, 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
const CHAT_TOKEN = 'placeholder-chat-token-0123456789abcdefgh';

const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...dbTargets.map((x) => ({ name: x.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await x.open(), now) })),
];

describe.each(envs)('Key 前缀路由 + 对话按用户路由（#179）[$name]', (env) => {
  let mock: MockLiteLLM;
  let t: TwoAccounts;
  let upstream: string[] = [];
  let bodies: string[] = [];

  beforeAll(async () => {
    mock = await startMockLiteLLM();
    t = await twoAccounts(
      {
        name: env.name,
        make: async (now) => {
          const deps = await env.make(now);
          deps.litellm = new LiteLLMAdmin({ baseUrl: mock.url, masterKey: MOCK_MASTER_KEY, timeoutMs: 2000 });
          deps.chatFetch = (async (_u: unknown, init?: { body?: string }) => {
            const b = JSON.parse(String(init?.body)) as { model: string };
            upstream.push(b.model);
            bodies.push(String(init?.body));
            return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }) as typeof fetch;
          return deps;
        },
      },
      { CORE_CHAT_TOKEN: CHAT_TOKEN, LITELLM_BASE_URL: mock.url, LITELLM_MASTER_KEY: MOCK_MASTER_KEY },
    );
  });
  afterAll(async () => {
    await t.close();
    await mock.close();
  });

  const say = (token: string, model: string) =>
    t.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: { model, messages: [{ role: 'user', content: 'hi' }] } });

  it('账号加 Key：LiteLLM 里的部署带账号前缀；所有者的 Key 不加前缀；互相列不出对方', async () => {
    const o = await t.owner('POST', '/api/keys', { name: '所有者的', sourceUrl: 'https://example.com', apiKey: fakeKey('own1'), model: 'openai/gpt-owner', modelName: 'OwnerModel' });
    expect(o.statusCode).toBe(201);
    const x = await t.xiao('POST', '/api/keys', { name: '小号的', sourceUrl: 'https://example.com', apiKey: fakeKey('xia1'), model: 'openai/gpt-xiao', modelName: 'XiaoModel' });
    expect(x.statusCode).toBe(201);
    const names = [...mock.deployments.values()].map((d) => d.model_name).sort();
    expect(names).toEqual(['OwnerModel', `${userPrefix(t.xiaoId)}/XiaoModel`].sort());
    expect((await t.xiao('GET', '/api/keys')).json().keys.map((k: { name: string }) => k.name)).toEqual(['小号的']);
    expect((await t.owner('GET', '/api/keys')).json().keys.map((k: { name: string }) => k.name)).toEqual(['所有者的']);
    expect((await t.xiao('GET', '/api/keys')).body).not.toContain('所有者的');
  });

  it('越权：小号改 / 删所有者的 Key 与改删不存在的 Key 完全一样（404），部署不变；反向同理', async () => {
    const ownerKey = (await t.owner('GET', '/api/keys')).json().keys[0].id as string;
    const xiaoKey = (await t.xiao('GET', '/api/keys')).json().keys[0].id as string;
    const before = mock.deployments.size;
    await expectSameAsMissing((id) => t.xiao('DELETE', `/api/keys/${id}`), ownerKey, '00000000-0000-0000-0000-000000000000');
    await expectSameAsMissing((id) => t.xiao('PATCH', `/api/keys/${id}`, { name: 'x' }), ownerKey, '00000000-0000-0000-0000-000000000000');
    expectDenied(await t.xiao('PATCH', `/api/keys/${ownerKey}`, { apiKey: fakeKey('evil') }), ['所有者的']);
    expect(mock.deployments.size).toBe(before);
    expectDenied(await t.owner('DELETE', `/api/keys/${xiaoKey}`));
    expect(mock.deployments.size).toBe(before);
  });

  it('小号建成员 + 带 models:chat 的令牌：对话上游名带小号前缀，不落到所有者的 Key', async () => {
    expect((await t.xiao('POST', '/api/members', { name: 'XiaoModel' })).statusCode).toBeLessThan(300);
    const c = await t.xiao('POST', '/api/clients', { name: 'chat', scopes: ['models:chat'] });
    expect(c.statusCode).toBeLessThan(300);
    const token = c.json().token as string;
    upstream = [];
    const r = await say(token, 'aroomo/xiaomodel');
    expect(r.statusCode).toBe(200);
    expect(upstream).toEqual([`${userPrefix(t.xiaoId)}/XiaoModel`]);
  });

  it('小号的 /v1/models 只列自己的成员，看不出所有者的成员', async () => {
    await t.owner('POST', '/api/members', { name: 'OwnerSecretMember' });
    const token = (await t.xiao('POST', '/api/clients', { name: 'chat2', scopes: ['models:chat'] })).json().token as string;
    const m = await t.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${token}` } });
    expect(m.statusCode).toBe(200);
    expect(m.body).not.toContain('ownersecretmember');
    expect(m.body).toContain('xiaomodel');
    // 点名所有者的成员 = 点名一个不存在的成员
    upstream = [];
    const r = await say(token, 'aroomo/ownersecretmember');
    expect(r.body).not.toContain('OwnerSecretMember');
    expect(upstream).toEqual([]);
  });

  it('缺权限 / 无效令牌：没有 models:chat 的客户端令牌、乱写的令牌都是 401，且不调上游', async () => {
    const noScope = (await t.xiao('POST', '/api/clients', { name: 'lib', scopes: ['library:read'] })).json().token as string;
    upstream = [];
    expect((await say(noScope, 'aroomo')).statusCode).toBe(401);
    expect((await say('not-a-real-token', 'aroomo')).statusCode).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('所有者的 CORE_CHAT_TOKEN 仍走所有者路径（不加前缀）', async () => {
    upstream = [];
    const r = await say(CHAT_TOKEN, 'aroomo/ownermodel');
    expect(r.statusCode).toBe(200);
    expect(upstream.every((u) => !u.startsWith('u'))).toBe(true);
  });

  it('吊销后的令牌立即失效', async () => {
    const c = (await t.xiao('POST', '/api/clients', { name: 'tmp', scopes: ['models:chat'] })).json();
    const token = c.token as string;
    expect((await say(token, 'aroomo')).statusCode).toBe(200);
    await t.xiao('DELETE', `/api/clients/${c.client.id as string}`);
    expect((await say(token, 'aroomo')).statusCode).toBe(401);
  });

  it('必改1/2：所有者的规矩不进小号的上游请求；小号任何调用方式的上游名都带小号前缀', async () => {
    await t.deps.pubmem.put('owner', 'rules', '规矩', 'OWNER-SECRET-RULE', t.clock.now());
    const token = (await t.xiao('POST', '/api/clients', { name: 'chat3', scopes: ['models:chat'] })).json().token as string;
    bodies = [];
    upstream = [];
    for (const m of ['OwnerModel', 'openai/gpt-owner', 'aroomo', 'aroomo/auto', 'aroomo/xiaomodel']) await say(token, m);
    await t.owner('POST', '/api/members', { name: 'OwnerModel2' });
    const mineUpstream = [...upstream];
    const mineBodies = bodies.join('');
    bodies = [];
    await say(CHAT_TOKEN, 'aroomo/ownermodel2');
    const ownerBody = bodies.join('');
    const prefix = `${userPrefix(t.xiaoId)}/`;
    expect(mineUpstream.length).toBeGreaterThan(0);
    expect(mineUpstream.every((u) => u.startsWith(prefix))).toBe(true);
    expect(ownerBody).toContain('OWNER-SECRET-RULE'); // 对照：所有者自己的对话带规矩，说明这里的测法有效
    expect(mineBodies).not.toContain('OWNER-SECRET-RULE');
  });

  it('必改3：非法 user id 报错（不先删字符）', () => {
    const hex = 'a'.repeat(32);
    expect(() => userPrefix(`zz${hex}`)).toThrow();
    expect(() => userPrefix(`${hex}-`)).toThrow();
    expect(() => userPrefix(`${hex}x`)).toThrow();
    expect(userPrefix(hex.toUpperCase())).toBe(`u${hex}`);
    expect(userPrefix('AAAAAAAA-aaaa-AAAA-aaaa-aaaaaaaaaaaa')).toBe(`u${hex}`);
  });

  it('必改4：小号整条替换 Key 后新部署带前缀、旧部署删除、所有者部署不变', async () => {
    const xk = (await t.xiao('GET', '/api/keys')).json().keys[0].id as string;
    const ownerBefore = [...mock.deployments.values()].filter((d) => d.model_name === 'OwnerModel').length;
    const r = await t.xiao('PATCH', `/api/keys/${xk}`, { apiKey: fakeKey('xia2') });
    expect(r.statusCode).toBeLessThan(300);
    const mine = [...mock.deployments.values()].filter((d) => String(d.model_name).endsWith('/XiaoModel'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.model_name).toBe(`${userPrefix(t.xiaoId)}/XiaoModel`);
    expect([...mock.deployments.values()].filter((d) => d.model_name === 'OwnerModel')).toHaveLength(ownerBefore);
  });

  it('必改5：所有者 list 不含账号的 Key，账号 list 不含所有者的（本存储）', async () => {
    const o = (await t.owner('GET', '/api/keys')).json().keys.map((k: { name: string }) => k.name);
    expect(o).not.toContain('小号的');
    expect((await t.xiao('GET', '/api/keys')).json().keys.map((k: { name: string }) => k.name)).not.toContain('所有者的');
  });
});
