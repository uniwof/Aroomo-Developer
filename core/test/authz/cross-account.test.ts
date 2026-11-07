/**
 * #176（D208 第二步）：跨账号越权遍历，内存 / PGlite（CI 里再加真 PostgreSQL）三套存储各跑一遍。
 *
 * 三个身份：所有者（所有者令牌）、家人 B（另一个普通账号）、家人 A（小号，攻击方）。
 * 所有者和 B 先各自建一份带标记的数据（成员、Key、保险箱、资源库、公共记忆、会话、客户端令牌、任务、HTTP 工具、设置……），
 * 然后 A 对路由表里的**每一条**路由（route-registry 自动收集，不手写清单）发请求：
 *   - 路径参数换成所有者 / B 的真实 id（「改参」）；
 *   - 改动类接口带上一份能过校验的请求体（「重放」：和受害者自己发的一样，只是换成 A 的凭据），体里引用别人 id 的地方也换成别人的。
 * 判定：
 *   1. 只给所有者的路由（下面 OWNER_ONLY_FOR_FAMILY + 所有没声明 userRoute 的路由），A 一律 403；
 *   2. 任何响应里都不出现所有者 / B 的数据标记，也不 5xx；
 *   3. A 打完之后，所有者和 B 用自己的身份把全部读接口再读一遍，和打之前逐字节一致（A 什么也没改动、删掉、作废）；
 *   4. 重要确认令牌不能跨账号用：B 拿到的确认令牌，A 拿去删 B 的或删自己的都不行；
 *   5. /mcp：A 发的全范围客户端令牌，tools/list 每个工具带别人的 id 调一遍，结果里没有别人的数据。
 * 新增带路径参数的路由、或新增改动类路由时，要在 PARAM_KIND / BODIES 里补一行，否则「覆盖」那条失败（见 docs/authz-testing.md）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { CAPABILITY_SEED } from '../../src/capabilities/seed.js';
import { LiteLLMAdmin } from '../../src/keys/litellm.js';
import { CLIENT_SCOPES } from '../../src/clients/types.js';
import { seedXiaohao } from '../../src/users/seed.js';
import { fakePw, twoAccountEnvs, type Inject, type TwoAccounts, twoAccounts } from '../helpers/two-accounts.js';
import { ownerAuth } from '../helpers/db.js';
import { MOCK_MASTER_KEY, type MockLiteLLM, startMockLiteLLM } from '../helpers/mock-litellm.js';
import { seenRoutes, type SeenRoute } from './route-registry.js';

vi.mock('fastify', async (orig) => (await import('./route-registry.js')).wrapFastify(await orig<typeof import('fastify')>()));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** xiaoClient = 小号自己发的全范围客户端令牌（arc_），也当攻击方 */
type Who = 'owner' | 'b' | 'xiao' | 'xiaoClient';
/** 每个身份的数据都带自己的标记（小写字母数字，能过各种 pattern 校验）；响应里出现别人的标记 = 泄露 */
const MARK: Record<Who, string> = { owner: 'ownermark176', b: 'bmark176', xiao: 'xiaomark176', xiaoClient: 'xiaomark176' };
const B_EMAIL = 'family-b-176@example.test';
const B_PW = fakePw(176);
/** 种子里的一个「试用」能力（试用到期日按账号存） */
const TRIAL_CAP = [...CAPABILITY_SEED.items, ...CAPABILITY_SEED.tools].find((c) => c.access === 'trial')!.id;
const MISSING_UUID = '00000000-0000-4000-8000-0000000000ff';

/**
 * 路径参数属于哪类资源（按「参数前一段 + 参数名」认）。新路由的参数不在这里 → 覆盖测试失败，提醒补夹具。
 */
const PARAM_KIND: Record<string, string> = {
  'assistants/:id': 'assistant',
  'runs/:run': 'run',
  'clients/:id': 'client',
  'http-tools/:id': 'httpTool',
  'keys/:id': 'key',
  'library/:id': 'library',
  'members/:id': 'member',
  'memory/:topic': 'memory',
  'vault/:id': 'vault',
  'confirm/:id': 'confirm',
  'conversations/:id': 'conversation',
  'tasks/:id': 'task',
  'takeover/:tid': 'takeover',
  'takeovers/:tid': 'takeover',
  'inbox/:id': 'inbox',
  'actions/:actionId': 'action',
  'users/:id': 'user',
  'projects/:id': 'project',
  'versions/:id': 'version',
  'capabilities/:id': 'capability',
  'limits/:memberId': 'member',
};

type Ids = Record<string, string>;
type BodyFn = (who: Who, ids: Ids) => object | undefined;

/**
 * 改动类路由的请求体（能过 schema 校验，才测得到真正的权限 / 归属判断）。key 是「方法 路由模式」。
 * 值为 undefined 表示这个接口不收请求体。新改动类路由不在这里 → 覆盖测试失败。
 */
const BODIES: Record<string, BodyFn> = {
  'DELETE /api/assistants/:id': () => undefined,
  'DELETE /api/clients/:id': () => undefined,
  'DELETE /api/gateway/http-tools/:id': () => undefined,
  'DELETE /api/keys/:id': () => ({}),
  'DELETE /api/library/:id': () => undefined,
  'DELETE /api/members/:id': () => undefined,
  'DELETE /api/members/:id/pin': () => undefined,
  'DELETE /api/memory/:topic': () => undefined,
  'DELETE /api/vault/:id': () => ({}),
  'PATCH /api/assistants/:id': (w) => ({ name: `${MARK[w]} renamed` }),
  'PATCH /api/conversations/:id': (w) => ({ title: `${MARK[w]} renamed` }),
  'PATCH /api/keys/:id': (w) => ({ name: `${MARK[w]}x` }),
  'PATCH /api/members/:id': (w) => ({ name: `${MARK[w]}renamed` }),
  'PATCH /api/work/projects/:id': (w) => ({ name: `${MARK[w]} renamed` }),
  'POST /api/assistants': (w, i) => ({ name: `${MARK[w]} asst`, members: [i.member] }),
  'POST /api/assistants/:id/pause': () => undefined,
  'POST /api/assistants/:id/read': () => undefined,
  'POST /api/assistants/:id/resume': () => undefined,
  'POST /api/assistants/:id/runs': () => undefined,
  'POST /api/assistants/:id/runs/:run/cancel': () => undefined,
  'POST /api/assistants/preview': (w, i) => ({ name: `${MARK[w]} asst`, members: [i.member] }),
  'POST /api/auth/logout': () => undefined,
  'POST /api/auth/logout-all': () => undefined,
  'POST /api/auth/password': () => ({ currentPassword: fakePw(1), newPassword: fakePw(9) }),
  'POST /api/chat/stream': (_w, i) => ({ conversationId: i.conversation, messages: [{ role: 'user', content: 'hi' }] }),
  'POST /api/clients': (w) => ({ name: `${MARK[w]} client`, scopes: ['library:read'] }),
  'POST /api/clients/revoke-all': () => undefined,
  'POST /api/confirm/:id/steps': () => ({ step: 1 }),
  'POST /api/conversations': (w) => ({ title: `${MARK[w]} conv` }),
  'POST /api/conversations/:id/read': () => ({}),
  'POST /api/conversations/import': (w) => ({ conversations: [{ id: MISSING_UUID, title: `${MARK[w]} imported`, messages: [] }] }),
  'POST /api/executor/hello': () => ({ deviceName: 'd', platform: 'p', version: '1' }),
  'POST /api/executor/tasks/:id/progress': () => ({ stage: 'x', message: 'x' }),
  'POST /api/executor/tasks/:id/result': () => ({ status: 'succeeded', summary: 'x' }),
  'POST /api/executor/tasks/:id/secret': (_w, i) => ({ secretId: i.vault, field: 'value' }),
  'POST /api/executor/tasks/:id/takeover': () => ({ reason: 'x', message: 'x' }),
  'POST /api/executor/tasks/claim': () => ({ waitSec: 0 }),
  'POST /api/gateway/call': (_w, i) => ({ tool: i.httpTool, args: {} }),
  'POST /api/inbox': (w) => ({ group: 'brief', kind: 'info', title: `${MARK[w]} inbox` }),
  'POST /api/inbox/:id/actions/:actionId': () => ({}),
  'POST /api/inbox/:id/dismiss': () => ({}),
  'POST /api/inbox/dismiss': (_w, i) => ({ ids: [i.inbox] }),
  'POST /api/keys': (w) => ({ name: `${MARK[w]}key`, sourceUrl: 'https://example.test', apiKey: `${MARK[w]}-apikey-0123456789`, model: 'openai/gpt-4o-mini' }),
  'POST /api/library': (w) => ({ kind: 'idea', title: `${MARK[w]} note`, body: `${MARK[w]} body` }),
  'POST /api/members': (w) => ({ name: `${MARK[w]}bot` }),
  'POST /api/members/:id/onboard': () => undefined,
  'POST /api/members/:id/purge': () => ({}),
  'POST /api/members/:id/restore': () => undefined,
  'POST /api/memory/:topic/rollback': () => ({ version: 1 }),
  'POST /api/push/subscriptions': () => ({ endpoint: 'https://push.example.test/x', keys: { p256dh: 'k', auth: 'a' } }),
  'POST /api/push/subscriptions/remove': () => ({ endpoint: 'https://push.example.test/x' }),
  'POST /api/push/test': () => ({}),
  'POST /api/tasks': (_w, i) => ({ kind: 'browse', site: 'https://example.test', secrets: [{ secretId: i.vault, field: 'password' }] }),
  'POST /api/tasks/:id/cancel': () => undefined,
  'POST /api/tasks/:id/takeovers/:tid/resolve': () => ({ cancel: true }),
  'POST /api/users/:id/disable': () => undefined,
  'POST /api/users/:id/enable': () => undefined,
  'POST /api/users/:id/reset-link': () => undefined,
  'POST /api/users/invites': (w) => ({ email: `${MARK[w]}@example.test` }),
  'POST /api/vault': (w) => ({ name: `${MARK[w]}vault`, kind: 'password', value: `${MARK[w]}-secret-value` }),
  'POST /api/vault/:id/reveal': () => ({}),
  'POST /api/work/projects': (w) => ({ name: `${MARK[w]} project` }),
  'POST /api/work/projects/:id/sync': () => undefined,
  'PUT /api/capabilities/:id/trial': () => ({ endsAt: '2027-01-01' }),
  'PUT /api/executor-allowlist': (w) => ({ sites: [`https://${MARK[w]}.example.test`] }),
  'PUT /api/gateway/http-tools': (w) => ({ def: { toolId: `${MARK[w]}tool`, name: `${MARK[w]}tool`, baseUrl: 'https://api.example.test', allowedHosts: ['api.example.test'], risk: 'read' } }),
  'PUT /api/interrupt-budget': () => ({ daily: 3 }),
  'PUT /api/members/:id/pin': () => undefined,
  'PUT /api/members/order': (_w, i) => ({ ids: [i.member] }),
  'PUT /api/memory/:topic': (w) => ({ title: `${MARK[w]} topic`, body: `${MARK[w]} memory body` }),
  'PUT /api/settings/lead': (_w, i) => ({ leadId: i.member }),
  'PUT /api/settings/security': () => ({ sensitiveProtect: false }),
  'PUT /api/usage/limits/:memberId': () => ({ dailyLimit: 1 }),
  'PUT /api/vault/:id': (w) => ({ value: `${MARK[w]}-overwritten` }),
};

/**
 * 声明了 userRoute、但只给所有者 / 管理员的路由：家人账号必须 403（不是 404、不是 400）。
 * 没声明 userRoute 的路由不用列：authz.test.ts 和下面都会要求它们对家人 403。
 */
const OWNER_ONLY_FOR_FAMILY = [
  'DELETE /api/assistants/:id',
  'GET /api/assistants',
  'GET /api/assistants/:id',
  'GET /api/assistants/:id/messages',
  'GET /api/assistants/:id/runs',
  'GET /api/assistants/:id/runs/:run',
  'PATCH /api/assistants/:id',
  'POST /api/assistants',
  'POST /api/assistants/:id/pause',
  'POST /api/assistants/:id/read',
  'POST /api/assistants/:id/resume',
  'POST /api/assistants/:id/runs',
  'POST /api/assistants/:id/runs/:run/cancel',
  'POST /api/assistants/preview',
  'POST /api/conversations/import',
  'GET /api/push',
  'POST /api/push/subscriptions',
  'POST /api/push/subscriptions/remove',
  'POST /api/push/test',
  'GET /api/work/projects',
  'GET /api/work/projects/:id',
  'GET /api/work/projects/:id/versions',
  'GET /api/work/versions/:id',
  'PATCH /api/work/projects/:id',
  'POST /api/work/projects',
  'POST /api/work/projects/:id/sync',
  'GET /api/users',
  'POST /api/users/invites',
  'POST /api/users/:id/disable',
  'POST /api/users/:id/enable',
  'POST /api/users/:id/reset-link',
  'GET /api/settings/security',
];

/** 改动后会让攻击方自己的会话失效的路由：放到最后打 */
const SELF_ENDING = ['POST /api/auth/logout', 'POST /api/auth/logout-all', 'POST /api/auth/password'];

const key = (r: Pick<SeenRoute, 'method' | 'url'>) => `${r.method} ${r.url}`;
const uniq = (rs: SeenRoute[]) => [...new Map(rs.map((r) => [key(r), r])).values()];
const apiRoutes = () => uniq(seenRoutes.filter((r) => r.url.startsWith('/api/')));
const paramKinds = (url: string): string[] =>
  [...url.matchAll(/([^/]+)\/(:[A-Za-z_]+)/g)].map((m) => PARAM_KIND[`${m[1]}/${m[2]}`] ?? `?${m[1]}/${m[2]}`);
const fill = (url: string, ids: Ids): string =>
  url.replace(/([^/]+)\/(:[A-Za-z_]+)/g, (_s, seg: string, p: string) => `${seg}/${encodeURIComponent(ids[PARAM_KIND[`${seg}/${p}`] ?? ''] ?? MISSING_UUID)}`);

describe.each(twoAccountEnvs)('#176 跨账号越权遍历 [$name]', (env) => {
  let t: TwoAccounts;
  let litellm: MockLiteLLM;
  const headers: Record<Who, Record<string, string>> = { owner: ownerAuth, b: {}, xiao: {}, xiaoClient: {} };
  const ids: Record<Who | 'missing', Ids> = { owner: {}, b: {}, xiao: {}, xiaoClient: {}, missing: {} };
  const call = (who: Who, method: string, url: string, payload?: object): Promise<Inject> =>
    t.app.inject({ method, url, headers: headers[who], ...(payload !== undefined ? { payload } : {}) } as InjectOptions);
  /** 建一份资源；失败直接报（夹具坏了要看得见），返回 json */
  /** 遇到重要确认（428）就由本人走完两步，带确认令牌重发 */
  const confirmed = async (who: Who, method: string, url: string, payload?: object): Promise<Inject> => {
    const first = await call(who, method, url, payload);
    if (first.statusCode !== 428) return first;
    const token = await confirmToken(who, first);
    return call(who, method, url, { ...(payload ?? {}), confirmToken: token });
  };
  const confirmToken = async (who: Who, res428: Inject): Promise<string> => {
    const ch = res428.json().error.confirm as { stepUrl: string };
    expect((await call(who, 'POST', ch.stepUrl, { step: 1 })).statusCode).toBe(200);
    t.clock.advance(3000);
    const s2 = await call(who, 'POST', ch.stepUrl, { step: 2 });
    expect(s2.statusCode, s2.body).toBe(200);
    return s2.json().confirmToken as string;
  };
  const make = async (who: Who, method: string, url: string, payload?: object): Promise<Json> => {
    const r = await confirmed(who, method, url, payload);
    expect(r.statusCode, `${who} ${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`).toBeLessThan(300);
    return r.body ? (r.json() as Json) : {};
  };

  async function seed(who: Exclude<Who, 'xiao'>): Promise<void> {
    const m = MARK[who];
    const i = ids[who];
    i.member = (await make(who, 'POST', '/api/members', { name: `${m}bot` })).member.id;
    i.memory = `topic-${who}`; // 主题名不带标记：攻击方在自己名下建同名主题、回显主题名不算泄露
    await make(who, 'PUT', `/api/memory/${i.memory}`, { title: `${m} topic`, body: `${m} memory body` });
    i.library = (await make(who, 'POST', '/api/library', { kind: 'idea', title: `${m} note`, body: `${m} body` })).item.id;
    i.vault = (await make(who, 'POST', '/api/vault', { name: `${m}vault`, kind: 'password', value: `${m}-secret-value` })).secret.id;
    i.key = (await make(who, 'POST', '/api/keys', { name: `${m}key`, sourceUrl: 'https://example.test', apiKey: `${m}-apikey-0123456789`, model: 'openai/gpt-4o-mini' })).key.id;
    // 家人账号登记 HTTP 工具要所有者本人确认（D251），B 没有，只种所有者的
    if (who === 'owner') i.httpTool = (await make(who, 'PUT', '/api/gateway/http-tools', { def: { toolId: `${m}tool`, name: `${m}tool`, baseUrl: 'https://api.example.test', allowedHosts: ['api.example.test'], risk: 'read' } })).tool.toolId;
    i.conversation = (await make(who, 'POST', '/api/conversations', { title: `${m} conv` })).conversation.id;
    i.client = (await make(who, 'POST', '/api/clients', { name: `${m} client`, scopes: ['library:read'] })).client.id;
    i.task = (await make(who, 'POST', '/api/tasks', { kind: 'browse', site: `https://${m}.example.test`, instruction: `${m} task` })).task.id;
    await make(who, 'PUT', '/api/executor-allowlist', { sites: [`https://${m}.example.test`] });
    const store = who === 'owner' ? t.deps.members : t.deps.members.forUser(ids.b.user!);
    const mem = (await store.get(i.member!))!;
    await store.update({ ...mem, modelCaps: { mode: 'chat', maxInputTokens: 128000, supportsTools: true, checkedAt: t.clock.now().toISOString() } });
    await make(who, 'PUT', '/api/settings/lead', { leadId: i.member });
    await make(who, 'PUT', `/api/usage/limits/${i.member}`, { dailyLimit: 7 });
    await make(who, 'PUT', `/api/memory/${i.memory}`, { title: `${m} topic v2`, body: `${m} memory body v2` }); // 有第 1 版可回滚
    await make(who, 'PUT', '/api/interrupt-budget', { daily: 5 });
    i.capability = TRIAL_CAP;
    await make(who, 'PUT', `/api/capabilities/${i.capability}/trial`, { endsAt: '2027-03-01' });
    // 收件箱卡片（所有者走接口；账号没有发卡接口，直接写库，和后台任务给账号发卡一样）
    const card = { id: randomUUID(), group: 'decision' as const, kind: 'k176', urgency: 'normal' as const, title: `${m} inbox`, summary: `${m} summary`, related: { type: 'task', id: i.task! }, actions: [{ id: 'ok', label: 'OK', kind: 'ack' }], status: 'open' as const, createdAt: t.clock.now() };
    i.inbox = (await t.deps.inbox.insertDedup(who === 'owner' ? card : { ...card, userId: ids.b.user! } as never)).item.id;
    i.action = 'ok';
  }

  beforeAll(async () => {
    litellm = await startMockLiteLLM();
    const withGateway = { name: env.name, make: async (now: () => Date) => ({ ...(await env.make(now)), litellm: new LiteLLMAdmin({ baseUrl: litellm.url, masterKey: MOCK_MASTER_KEY, timeoutMs: 2000 }) }) };
    t = await twoAccounts(withGateway, { VAULT_KEY: randomBytes(32).toString('base64') });
    headers.xiao = t.xiaoHeaders;
    const b = await seedXiaohao(t.deps.users, { email: B_EMAIL, password: B_PW, displayName: `${MARK.b}user` }, t.clock.now);
    ids.b.user = b.userId;
    ids.xiao.user = t.xiaoId;
    const login = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email: B_EMAIL, password: B_PW } });
    expect(login.statusCode).toBe(200);
    headers.b = { authorization: `Bearer ${login.json().token as string}` };
    await seed('owner');
    await seed('b');
    for (const k of Object.values(PARAM_KIND)) ids.missing[k] = MISSING_UUID;
    Object.assign(ids.missing, { member: 'missingbot', memory: 'topic-missing', httpTool: 'missingtool', capability: TRIAL_CAP, action: 'ok' });
    headers.xiaoClient = { authorization: `Bearer ${(await make('xiao', 'POST', '/api/clients', { name: 'xiao all', scopes: [...CLIENT_SCOPES], rateLimitPerMin: 6000 })).token as string}` };
  });
  afterAll(async () => {
    await t?.close();
    await litellm?.close();
  });


  /** 受害者用自己的身份读一遍全部读接口（路径参数用自己的 id），作为「没被改动」的快照 */
  const SNAPSHOT_SKIP = new Set([
    'GET /api/audit', // 审计会记下攻击方被拒的请求，本来就该变
  ]);
  async function snapshot(who: 'owner' | 'b'): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of apiRoutes().filter((x) => x.method === 'GET' && !SNAPSHOT_SKIP.has(key(x)))) {
      const res = await call(who, 'GET', fill(r.url, ids[who]));
      out[key(r)] = `${res.statusCode} ${res.body}`;
    }
    return out;
  }

  /** 攻击方以 victim 的 id / 请求体打一条路由 */
  const attack = (r: SeenRoute, victim: 'owner' | 'b' | 'missing', attacker: 'xiao' | 'xiaoClient' = 'xiao'): Promise<Inject> => {
    // 请求体用攻击方自己的标记（自己建的东西回显不算泄露），引用的 id 换成受害者的
    const body = r.method === 'GET' ? undefined : BODIES[key(r)]?.('xiao', ids[victim]);
    // 遇到重要确认，攻击方自己把两步点完再重发（攻击方能确认自己的挑战；确认令牌必须绑定账号和这次操作）
    return (attacker === 'xiao' ? confirmed : call)(attacker, r.method, fill(r.url, ids[victim]) + (/\/api\/(search|library)$/.test(r.url) && victim !== 'missing' ? `?q=${MARK[victim]}` : ''), body);
  };
  const errCode = (r: Inject): string | null => {
    try {
      return (r.json() as { error?: { code?: string } }).error?.code ?? null;
    } catch {
      return null;
    }
  };
  const leaked = (res: Inject): Who[] => (['owner', 'b'] as const).filter((w) => res.body.includes(MARK[w]));

  it('覆盖：每个路径参数都认得是哪类资源，每个改动类路由都有请求体夹具', () => {
    const unknownParams = apiRoutes().flatMap((r) => paramKinds(r.url).filter((k) => k.startsWith('?')).map((k) => `${key(r)} ${k}`));
    expect(unknownParams, '新路由的路径参数要在 PARAM_KIND 里登记').toEqual([]);
    const noBody = apiRoutes().filter((r) => r.method !== 'GET' && !(key(r) in BODIES)).map(key);
    expect(noBody, '新改动类路由要在 BODIES 里给一份能过校验的请求体').toEqual([]);
    const stale = Object.keys(BODIES).filter((k) => !apiRoutes().some((r) => key(r) === k));
    expect(stale, 'BODIES 里有已经不存在的路由').toEqual([]);
    for (const k of OWNER_ONLY_FOR_FAMILY) expect(apiRoutes().some((r) => key(r) === k), k).toBe(true);
  });

  it('只给所有者的路由：家人账号带着所有者的 id 和合法请求体，一律 403', async () => {
    const bad: string[] = [];
    for (const r of apiRoutes().filter((x) => x.config.userRoute !== true || OWNER_ONLY_FOR_FAMILY.includes(key(x)))) {
      const res = await attack(r, 'owner');
      if (res.statusCode !== 403) bad.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    expect(bad).toEqual([]);
  });

  it('非 /api 的所有者接口（/v1、/internal）：家人账号令牌进不去', async () => {
    for (const [method, url, payload] of [
      ['GET', '/v1/models', undefined],
      ['POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }],
      ['POST', '/v1/responses', { input: 'x' }],
      ['POST', '/internal/route-preview', {}],
    ] as const) {
      const res = await call('xiao', method, url, payload);
      expect([401, 403, 503], `${method} ${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(leaked(res)).toEqual([]);
    }
  });


  it('重要确认令牌不能跨账号：所有者点完确认拿到的令牌，小号拿去删所有者的或删自己的保险箱条目都不行', async () => {
    // 家人账号自己做不了重要确认（只有普通确认，直接放行），能拿到重要确认令牌的只有所有者
    const own = (await make('xiao', 'POST', '/api/vault', { name: 'xiaoreplay', kind: 'note', value: 'xiao-replay' })).secret.id as string;
    const first = await call('owner', 'DELETE', `/api/vault/${ids.owner.vault}`, {});
    expect(first.statusCode).toBe(428);
    const token = await confirmToken('owner', first);
    for (const id of [ids.owner.vault!, own]) {
      const res = await call('xiao', 'DELETE', `/api/vault/${id}`, { confirmToken: token });
      expect([403, 404, 428], `小号用所有者的确认令牌删${id === own ? '自己的' : '所有者的'}条目 → ${res.statusCode}`).toContain(res.statusCode);
      expect(leaked(res)).toEqual([]);
    }
    expect(JSON.stringify((await call('owner', 'GET', '/api/vault')).json())).toContain(ids.owner.vault);
    expect(JSON.stringify((await call('xiao', 'GET', '/api/vault')).json())).toContain(own);
    // 小号也不能替所有者点确认的两步、看确认卡（/api/confirm 只给所有者）
    const ch = first.json().error.confirm as { stepUrl: string; id?: string };
    expect((await call('xiao', 'POST', ch.stepUrl, { step: 1 })).statusCode).toBe(403);
  });

  it('任务里声明别人的保险箱 id：小号自己的执行员领到任务也取不到别人的凭据', async () => {
    const tid = (await make('xiao', 'POST', '/api/tasks', { kind: 'login', site: 'https://example.test', secrets: [{ secretId: ids.owner.vault!, field: 'password' }, { secretId: ids.b.vault!, field: 'password' }] })).task.id as string;
    await call('xiaoClient', 'POST', '/api/executor/hello', { deviceName: 'd', platform: 'p', version: '1' });
    let claimed: string | undefined;
    for (let n = 0; n < 20 && claimed !== tid; n++) {
      const c = await call('xiaoClient', 'POST', '/api/executor/tasks/claim', { waitSec: 0 });
      expect(leaked(c)).toEqual([]);
      claimed = (c.json() as Json).task?.id;
      if (!claimed) break;
    }
    expect(claimed).toBe(tid);
    for (const secretId of [ids.owner.vault!, ids.b.vault!]) {
      const res = await call('xiaoClient', 'POST', `/api/executor/tasks/${tid}/secret`, { secretId, field: 'password' });
      expect(res.statusCode).toBe(404);
      expect(leaked(res)).toEqual([]);
    }
  });

  it('/mcp：小号的全范围客户端令牌，tools/list 里每个工具带别人的 id 调一遍，都拿不到别人的数据', async () => {
    const rpc = (method: string, params?: object) => call('xiaoClient', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
    const tools = (await rpc('tools/list')).json().result.tools as { name: string; inputSchema: { properties?: Record<string, { enum?: string[] }> } }[];
    expect(tools.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const victim of ['owner', 'b'] as const) {
      const v = ids[victim];
      // 每个参数按名字填别人的 id；查询词填别人的标记；枚举取第一个
      const guess = (name: string, p: { enum?: string[] }): unknown =>
        p.enum?.[0] ?? ({ id: v.library, topic: v.memory, taskId: v.task, q: MARK[victim], query: MARK[victim], site: 'https://example.test', url: 'https://example.test' } as Record<string, unknown>)[name] ?? MARK.xiao;
      for (const tool of tools) {
        const argSets = [Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).map(([n, p]) => [n, guess(n, p)]))];
        // get_task / cancel_task 的 id 是任务 id
        if (/task/.test(tool.name)) argSets.push({ ...argSets[0], id: v.task });
        for (const args of argSets) {
          const res = await rpc('tools/call', { name: tool.name, arguments: args });
          if (res.statusCode >= 500) bad.push(`${tool.name} [${victim}] → ${res.statusCode}`);
          if (leaked(res).length) bad.push(`${tool.name} [${victim}] 泄露：${res.body.slice(0, 200)}`);
        }
      }
    }
    expect(bad).toEqual([]);
    // 别人的数据确实在：所有者自己用 MCP 能搜到自己的
    const ownRes = await call('owner', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_library_item', arguments: { id: ids.owner.library } } });
    expect(ownRes.body).toContain(MARK.owner);
  });

  it('遍历全部路由（改参 + 重放）：家人账号读不到、改不了所有者和另一个家人的数据', async () => {
    const before = { owner: await snapshot('owner'), b: await snapshot('b') };
    // 快照本身要真的含有受害者的数据，否则「没变」说明不了什么
    expect(Object.values(before.owner).join('\n')).toContain(MARK.owner);
    expect(Object.values(before.b).join('\n')).toContain(MARK.b);
    expect(Object.values(before.b).join('\n')).not.toContain(MARK.owner);

    const routes = apiRoutes().filter((r) => !SELF_ENDING.includes(key(r)));
    const leaks: string[] = [];
    const errors: string[] = [];
    const oracle: string[] = [];
    const run = async (r: SeenRoute, victim: 'owner' | 'b', attacker: 'xiao' | 'xiaoClient' = 'xiao') => {
      const res = await attack(r, victim, attacker);
      const l = leaked(res);
      if (l.length) leaks.push(`${key(r)} [${victim}] 泄露 ${l.join(',')}：${res.body.slice(0, 200)}`);
      if (res.statusCode >= 500) errors.push(`${key(r)} [${victim}] → ${res.statusCode} ${res.body.slice(0, 120)}`);
      // 看不出存在：带别人的 id 和带根本不存在的 id，状态码、错误码一样（只看带路径参数的路由）
      if (r.url.includes(':')) {
        const miss = await attack(r, 'missing', attacker);
        if (res.statusCode !== miss.statusCode || errCode(res) !== errCode(miss)) oracle.push(`${key(r)} [${victim}/${attacker}] 别人的 id → ${res.statusCode} ${errCode(res)}，不存在的 id → ${miss.statusCode} ${errCode(miss)}`);
      }
    };
    // 先用小号自己发的全范围客户端令牌打一遍（执行员先 hello，领任务 / 取凭据才走得到归属判断），再用小号会话打一遍
    await call('xiaoClient', 'POST', '/api/executor/hello', { deviceName: 'd', platform: 'p', version: '1' });
    for (const victim of ['owner', 'b'] as const) for (const r of routes) await run(r, victim, 'xiaoClient');
    for (const victim of ['owner', 'b'] as const) for (const r of routes) await run(r, victim);
    // 会结束攻击方自己会话的放最后（logout-all 不能顺带踢掉别人）
    for (const k of SELF_ENDING) await run(apiRoutes().find((r) => key(r) === k)!, 'b');

    expect(leaks, '响应里出现了别人的数据').toEqual([]);
    expect(errors, '越权请求不该让服务出错').toEqual([]);
    expect(oracle, '能从响应差异看出别人的资源存在').toEqual([]);

    const after = { owner: await snapshot('owner'), b: await snapshot('b') };
    for (const victim of ['owner', 'b'] as const) {
      const changed = Object.keys(before[victim]).filter((k) => before[victim][k] !== after[victim][k]).map((k) => `${k}\n  前：${before[victim][k]!.slice(0, 300)}\n  后：${after[victim][k]!.slice(0, 300)}`);
      expect(changed, `${victim} 的数据被家人账号改动了`).toEqual([]);
    }
  });
});
