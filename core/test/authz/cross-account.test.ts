/**
 * #176（D208 第二步）：跨账号越权遍历。存储：内存、PGlite（以**非超级用户、非表所有者的应用角色**连接，RLS 真的生效），
 * 真 PostgreSQL（同样用应用角色；CI 里没配 CORE_TEST_DATABASE_URL 直接失败，本地没配才跳过）。
 * #335 负责人必改 8 条：三种注入分开发、逐表快照正向对照、真 PG CI 必跑、故意改坏可复现（scripts/authz-selfcheck.sh）、
 * 期望钉单值、/mcp 逐工具正向对照、RLS 写逐表 + 未开 RLS 白名单、执行员取凭据「别人的 = 不存在的」。
 *
 * 身份：所有者（所有者令牌）、家人 B（另一个普通账号）、家人 A（小号，攻击方：会话 + 它自己发的全范围 arc_ 客户端令牌 + Cookie 会话）。
 * 所有者和 B 先各自建一份带标记的数据，然后对路由表里的**每一条** /api 路由（route-registry 自动收集，不手写清单）：
 *   1. 正向对照：资源的主人用自己的凭据、自己的 id 打同一个请求，必须 2xx（证明请求真能走进处理器）；没跑通 = 测试失败，不跳过。
 *   2. 只给所有者的路由（OWNER_ONLY_FOR_FAMILY + 没声明 userRoute 的），攻击方严格 == 403；
 *      家人能用的路由，在 FAMILY / CLIENT 里逐条声明攻击方的期望（状态码 + 错误码），不让测试代码自己兜底判断；
 *      「空结果」只给按 scope 过滤的列表接口，且逐条声明（list: true）。
 *   3. 家人能用、带 id 的路由：别人的 id 和根本不存在的 id 都必须 404（不是 403），错误码一样（看不出存在）。
 *   4. 攻击前后直接对数据库按 owner / B 做快照比对（易变字段白名单写明理由），不比对响应；攻击前每张表 owner / B 都要有行（逐表正向对照）。
 *   5. 泄露检查：标记的明文、大小写变换、base64（含错位）、URL 编码、sha256、掩码后 4 位；范围含响应头和 SSE 流。
 *   6. 存储层：应用角色直接 SELECT 读不到别人的行、逐表写不进别人名下（RLS 真的生效）；没开 RLS 的表 = NO_RLS_TABLES 白名单。
 * 另外补的攻击面：路径之外的别人的 id（query、body 嵌套字段、ids 数组、翻页游标、排序 / 过滤参数、身份覆盖头），
 * 令牌提权（家人用自己的 arc_ 令牌签发更大范围 / 所有者级令牌、吊销 / 列出别人的令牌、过期 / 已吊销令牌还能不能用）。
 * 新增路由要在 PARAM_KIND / BODIES / FAMILY / CLIENT / POSITIVE 里补，否则「覆盖」那条失败（见 docs/authz-testing.md）。
 * 测试里全是占位凭据和标记（MARK、fakePw），和任何真实账号、真实密钥无关。
 */
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { CAPABILITY_SEED } from '../../src/capabilities/seed.js';
import { CLIENT_SCOPES, EXECUTOR_SCOPES } from '../../src/clients/types.js';
import { assertAppRoleSafe, grantAppRole } from '../../src/db/app-role.js';
import { createPgDb, type Db, type Queryable } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { systemScoped, userScoped } from '../../src/db/scope.js';
import { memoryDeps, pgDeps } from '../../src/deps.js';
import { b64u, generateVapidKeys } from '../../src/push/webpush.js';
import { seedXiaohao } from '../../src/users/seed.js';
import { addDeployment, type AssistantEnv, assistantEnv, baseBody } from '../helpers/assistants.js';
import { openPglite, ownerAuth } from '../helpers/db.js';
import { type DepsEnv, fakePw, type Inject, XIAOHAO_TEST_PASSWORD } from '../helpers/two-accounts.js';
import { seenRoutes, type SeenRoute } from './route-registry.js';

vi.mock('fastify', async (orig) => (await import('./route-registry.js')).wrapFastify(await orig<typeof import('fastify')>()));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Victim = 'owner' | 'b';
/** 非执行员的全部范围（#376 M4：执行员范围必须单独发一枚设备令牌，不能混在一起） */
const NON_EXECUTOR_SCOPES = CLIENT_SCOPES.filter((s) => !EXECUTOR_SCOPES.includes(s));
/** xiao* = 攻击方（小号）；*Client = 各自发的两枚客户端令牌（arc_）：非执行员全范围一枚 + 设备令牌一枚，打 /api/executor/* 时自动换用设备令牌（见 call）；*Cookie = 控制台 Cookie 会话；fresh = 正向对照临时建的一次性家人账号 */
type Who = Victim | 'xiao' | 'xiaoClient' | 'xiaoCookie' | 'ownerClient' | 'bClient' | 'bCookie' | 'fresh';
type Marked = Victim | 'xiao';
/** 每个身份的数据都带自己的标记（小写字母数字，能过各种 pattern 校验）；响应里出现别人的标记 = 泄露 */
const MARK: Record<Marked, string> = { owner: 'ownermark176', b: 'bmark176', xiao: 'xiaomark176' };
/** 会被掩码成「后 4 位」的值（API Key、保险箱条目）的尾巴：每人不同，掩码后也认得出是谁的 */
const TAIL: Record<Marked, string> = { owner: 'qz7o', b: 'qz7b', xiao: 'qz7x' };
const apiKeyOf = (w: Marked) => `${MARK[w]}-apikey-0123${TAIL[w]}`;
const secretOf = (w: Marked) => `${MARK[w]}-secret-value-${TAIL[w]}`;
const markOf = (w: Who): string => MARK[(w.startsWith('owner') ? 'owner' : w.startsWith('b') ? 'b' : 'xiao') as Marked];
const B_EMAIL = 'family-b-176@example.test';
const B_PW = fakePw(176);
const PW: Partial<Record<Who, string>> = { xiao: XIAOHAO_TEST_PASSWORD, b: B_PW };
const CSRF = { 'x-aroomo-request': '1' };
/** 种子里的一个「试用」能力（试用到期日按账号存） */
const TRIAL_CAP = [...CAPABILITY_SEED.items, ...CAPABILITY_SEED.tools].find((c) => c.access === 'trial')!.id;
const MISSING_UUID = '00000000-0000-4000-8000-0000000000ff';
/** 所有者对话令牌（占位，≥32 字符）：配上它 /v1 才真的走鉴权，家人会话令牌才拿得到写死的 401（不然入口先 503 CHAT_NOT_CONFIGURED） */
const CHAT_TOKEN = 'placeholder-chat-token-176-0000000000000000';
const VAPID = generateVapidKeys();
const pushKeys = () => ({ p256dh: b64u.enc(createECDH('prime256v1').generateKeys()), auth: b64u.enc(randomBytes(16)) });
/** 路由数下限（2026-11 快照）：被 feature flag / 环境变量关掉的插件路由不会被收集，少了就说明有路由没被遍历到 */
const MIN_API_ROUTES = 119;

/**
 * 必改 7：没开 RLS 的表（显式白名单，逐条写理由）。新增没开 RLS 的表不在这里 → 「存储层」用例失败。
 * 这些表的跨账号隔离靠应用层（WHERE user_id / 只给所有者的接口），由上面的接口遍历和数据库快照兜。
 */
const NO_RLS_TABLES: Record<string, string> = {
  // 理由一栏写的是现状，不是负责人的裁定。#345：P0（client_tokens / user_sessions / exec_* / executors / confirm_challenges）已在 0036 开 RLS，从名单删掉；core_settings（P1）已在 0037 开 RLS，同样删掉；users / user_invites / audit_log（P2）待做
  audit_log: '只追加；只给所有者读（GET /api/audit），按 actor_id 记',
  core_schema_migrations: '迁移记录，不属于任何账号',
  user_invites: '登录前按邀请码查',
  users: '登录前按邮箱查',
};

/** 应用角色：NOLOGIN、非超级用户、不能绕过 RLS、不是任何表的所有者（D206）。迁移和授权以表所有者身份做完再切过去 */
const APP_ROLE = 'aroomo_xacct_app_test';
const CREATE_APP_ROLE = `DO $$ BEGIN CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`;
async function pgliteAsAppRole(): Promise<Db> {
  const db = await openPglite();
  await db.exec(CREATE_APP_ROLE);
  await grantAppRole(db, APP_ROLE);
  await db.exec(`SET ROLE ${APP_ROLE}`);
  return db;
}
async function realPgAsAppRole(url: string): Promise<Db> {
  const schema = `x_${randomBytes(6).toString('hex')}`;
  const admin = createPgDb(url, { max: 1 });
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const owner = createPgDb(url, { schema, max: 1 });
  try {
    await migrate(owner);
    await owner.exec(CREATE_APP_ROLE);
    await grantAppRole(owner, APP_ROLE);
  } finally {
    await owner.close();
  }
  return createPgDb(url, { schema, max: 4, role: APP_ROLE });
}
/**
 * 必改 3：真 PostgreSQL 在 CI 里必跑。CI（环境变量 CI=true，GitHub Actions 自带）或 AROOMO_REQUIRE_REAL_PG=1 时，
 * 没配 CORE_TEST_DATABASE_URL 直接失败（见下面「真 PG 必须在场」）；本地两者都没设才跳过真 PG。
 */
const PG_URL = process.env.CORE_TEST_DATABASE_URL;
const REQUIRE_REAL_PG = process.env.CI === 'true' || process.env.CI === '1' || process.env.AROOMO_REQUIRE_REAL_PG === '1';
const envs: DepsEnv[] = [
  { name: 'memory', make: async (now) => memoryDeps(now) },
  { name: 'pglite-app-role', make: async (now) => pgDeps(await pgliteAsAppRole(), now) },
  ...(PG_URL ? [{ name: 'postgres-app-role', make: async (now: () => Date) => pgDeps(await realPgAsAppRole(PG_URL), now) }] : []),
];

describe('#176 真 PG 必须在场（CI）', () => {
  it.runIf(REQUIRE_REAL_PG)('CI 下必须配置 CORE_TEST_DATABASE_URL，否则失败（不是跳过）', () => {
    expect(PG_URL, 'CI 里没配真 PostgreSQL：跨账号越权测试只跑了内存 / PGlite，真 PG 那条路径没测到').toBeTruthy();
  });
  if (!REQUIRE_REAL_PG && !PG_URL) it.skip('本地没配 CORE_TEST_DATABASE_URL：跳过真 PG（CI 里会失败）', () => {});
});

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
/** w = 发请求的人（体里的名字带他的标记）；i = 体里引用的 id（攻击时换成受害者的）；n = 每次请求唯一的后缀（避免同名冲突） */
type BodyFn = (w: Who, i: Ids, n: string) => object | undefined;

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
  'PATCH /api/assistants/:id': (w) => ({ name: `${markOf(w)} renamed` }),
  'PATCH /api/conversations/:id': (w) => ({ title: `${markOf(w)} renamed` }),
  'PATCH /api/keys/:id': (w) => ({ name: `${markOf(w)}x` }),
  'PATCH /api/members/:id': (w) => ({ name: `${markOf(w)}renamed` }),
  'PATCH /api/work/projects/:id': (w) => ({ name: `${markOf(w)} renamed` }),
  'POST /api/assistants': (w, i, n) => baseBody({ name: `${markOf(w)} asst ${n}`, members: [i.member] }),
  'POST /api/assistants/:id/pause': () => undefined,
  'POST /api/assistants/:id/read': () => undefined,
  'POST /api/assistants/:id/resume': () => undefined,
  'POST /api/assistants/:id/runs': () => undefined,
  'POST /api/assistants/:id/runs/:run/cancel': () => undefined,
  'POST /api/assistants/preview': (w, i) => baseBody({ name: `${markOf(w)} asst`, members: [i.member] }),
  'POST /api/auth/logout': () => undefined,
  'POST /api/auth/logout-all': () => undefined,
  'POST /api/auth/password': (w) => ({ currentPassword: PW[w] ?? fakePw(1), newPassword: fakePw(9) }),
  'POST /api/chat/stream': (_w, i) => ({ conversationId: i.conversation, messages: [{ role: 'user', content: 'hi' }] }),
  'POST /api/clients': (w) => ({ name: `${markOf(w)} client`, scopes: ['library:read'] }),
  'POST /api/clients/revoke-all': () => undefined,
  'POST /api/confirm/:id/steps': () => ({ step: 1 }),
  'POST /api/conversations': (w) => ({ title: `${markOf(w)} conv` }),
  'POST /api/conversations/:id/read': () => ({}),
  'POST /api/conversations/import': (w) => ({ conversations: [{ id: randomUUID(), title: `${markOf(w)} imported`, messages: [] }] }),
  'POST /api/executor/hello': () => ({ deviceName: 'd', platform: 'p', version: '1' }),
  'POST /api/executor/tasks/:id/progress': () => ({ stage: 'x', message: 'x' }),
  'POST /api/executor/tasks/:id/result': () => ({ status: 'succeeded', summary: 'x' }),
  'POST /api/executor/tasks/:id/secret': (_w, i) => ({ secretId: i.vault, field: 'value' }),
  'POST /api/executor/tasks/:id/takeover': () => ({ reason: 'x', message: 'x' }),
  'POST /api/executor/tasks/claim': () => ({ waitSec: 0 }),
  'POST /api/gateway/call': (_w, i) => ({ tool: i.httpTool, args: {} }),
  'POST /api/inbox': (w) => ({ group: 'brief', kind: 'info', title: `${markOf(w)} inbox` }),
  'POST /api/inbox/:id/actions/:actionId': () => ({}),
  'POST /api/inbox/:id/dismiss': () => ({}),
  'POST /api/inbox/dismiss': (_w, i) => ({ ids: [i.inbox] }),
  'POST /api/keys': (w, _i, n) => ({ name: `${markOf(w)}key${n}`, sourceUrl: 'https://example.test', apiKey: apiKeyOf(markOf(w) === MARK.owner ? 'owner' : markOf(w) === MARK.b ? 'b' : 'xiao'), model: 'openai/gpt-4o-mini' }),
  'POST /api/library': (w) => ({ kind: 'idea', title: `${markOf(w)} note`, body: `${markOf(w)} body` }),
  'POST /api/members': (w, _i, n) => ({ name: `${markOf(w)}bot${n}` }),
  'POST /api/members/:id/onboard': () => undefined,
  'POST /api/members/:id/purge': () => ({}),
  'POST /api/members/:id/restore': () => undefined,
  'POST /api/memory/:topic/rollback': () => ({ version: 1 }),
  'POST /api/push/subscriptions': (_w, _i, n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/xacct${n}`, keys: pushKeys() }),
  'POST /api/push/subscriptions/remove': (_w, _i, n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/xacct${n}` }),
  'POST /api/push/test': () => ({}),
  'POST /api/tasks': (w, i) => ({ kind: 'browse', site: `https://${markOf(w)}.example.test`, secrets: [{ secretId: i.vault, field: 'value' }] }),
  'POST /api/tasks/:id/cancel': () => undefined,
  'POST /api/tasks/:id/takeovers/:tid/resolve': () => ({ cancel: true }),
  'POST /api/users/:id/disable': () => undefined,
  'POST /api/users/:id/enable': () => undefined,
  'POST /api/users/:id/reset-link': () => undefined,
  'POST /api/users/invites': (w, _i, n) => ({ email: `${markOf(w)}${n}@example.test` }),
  'POST /api/vault': (w, _i, n) => ({ name: `${markOf(w)}vault${n}`, kind: 'password', value: `${markOf(w)}-v${n}` }),
  'POST /api/vault/:id/reveal': () => ({}),
  'POST /api/work/projects': (w, _i, n) => ({ name: `${markOf(w)} project ${n}` }),
  'POST /api/work/projects/:id/sync': () => undefined,
  'PUT /api/capabilities/:id/trial': () => ({ endsAt: '2027-01-01' }),
  'PUT /api/executor-allowlist': (w) => ({ sites: [`https://${markOf(w)}.example.test`] }),
  'PUT /api/gateway/http-tools': (w, _i, n) => ({ def: { toolId: `${markOf(w)}tool${n}`, name: `${markOf(w)}tool${n}`, baseUrl: 'https://api.example.test', allowedHosts: ['api.example.test'], risk: 'read' } }),
  'PUT /api/interrupt-budget': (w) => ({ daily: markOf(w) === MARK.xiao ? 9 : 3 }),
  'PUT /api/members/:id/pin': () => undefined,
  'PUT /api/members/order': (_w, i) => ({ ids: [i.member] }),
  'PUT /api/memory/:topic': (w) => ({ title: `${markOf(w)} topic`, body: `${markOf(w)} memory body` }),
  'PUT /api/settings/lead': (_w, i) => ({ leadId: i.member }),
  'PUT /api/settings/security': () => ({ sensitiveProtect: false }),
  'PUT /api/usage/limits/:memberId': (w) => ({ dailyLimit: markOf(w) === MARK.xiao ? 9 : 1 }),
  'PUT /api/vault/:id': (w) => ({ value: `${markOf(w)}-overwritten` }),
};

/** 只读接口要带的查询串（受害者 / 攻击方都带同样的参数，查询词换成各自的标记） */
const QUERY: Record<string, (w: Who) => string> = {
  'GET /api/search': (w) => `?q=${markOf(w)}`,
  'GET /api/library': (w) => `?q=${markOf(w)}`,
};

/**
 * 声明了 userRoute、但只给所有者 / 管理员的路由：家人账号必须 403（不是 404、不是 400）。
 * 没声明 userRoute 的路由不用列：下面一律要求它们对家人 403。
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

/**
 * 攻击方的期望，逐条声明（不让测试代码自己兜底）：
 * - status / code：严格相等；
 * - 带路径参数的、或请求体引用了 id 的：别人的 id 和不存在的 id 结果必须完全一样（状态码 + 错误码）；
 * - list: true = 按 scope 过滤的列表接口，允许 200「空结果」：响应里不得出现受害者的任何资源 id；
 * - self：只作用在攻击方自己名下（主题名、能力 id 这类按账号分的命名空间），由数据库快照保证没碰到别人的行。
 */
interface Exp {
  /** 单值（必改 5：不许写「几个都行」） */
  status: number;
  code?: string;
  list?: true;
  /** 列表里允许出现的受害者 id 种类：攻击方自己把它写进了自己的记录（回显攻击方提交的值，不是泄露） */
  echoes?: string[];
  /** 为什么不是 404 / 403（自己名下的命名空间等） */
  why?: string;
}
const NF: Exp = { status: 404, code: 'NOT_FOUND' };
const LIST: Exp = { status: 200, list: true };
const FORBID: Exp = { status: 403, code: 'FORBIDDEN' };
/** 家人账号（小号会话）打家人能用的路由 */
const FAMILY: Record<string, Exp> = {
  'GET /api/auth/me': { status: 200, why: '只回自己' },
  'POST /api/auth/logout': { status: 204, why: '只结束攻击方自己的会话' },
  'POST /api/auth/logout-all': { status: 204, why: '只结束攻击方自己的会话' },
  'POST /api/auth/password': { status: 204, why: '改的是攻击方自己的密码' },
  'GET /api/vault': LIST,
  'POST /api/vault': { status: 201, why: '建在自己名下' },
  'PUT /api/vault/:id': NF,
  'POST /api/vault/:id/reveal': NF,
  'DELETE /api/vault/:id': NF,
  'POST /api/clients': { status: 201, why: '发给自己的令牌（提权另测）' },
  'GET /api/clients': LIST,
  'DELETE /api/clients/:id': NF,
  'POST /api/clients/revoke-all': { status: 200, why: '只吊销自己的令牌（之后别人的令牌照样能用，另测）' },
  'GET /api/gateway/tools': LIST,
  'POST /api/gateway/call': NF,
  'GET /api/gateway/http-tools': LIST,
  'PUT /api/gateway/http-tools': { status: 403, code: 'FORBIDDEN', why: '家人登记 HTTP 工具要所有者本人确认（D251）' },
  'DELETE /api/gateway/http-tools/:id': NF,
  'GET /api/interrupt-budget': { status: 200, why: '只回自己' },
  'PUT /api/interrupt-budget': { status: 200, why: '按账号存' },
  'GET /api/tasks/:id/takeovers': { status: 404, code: 'TASK_NOT_FOUND' },
  'POST /api/tasks/:id/takeovers/:tid/resolve': { status: 404, code: 'TAKEOVER_NOT_FOUND' },
  'POST /api/tasks': { status: 201, why: '任务建在自己名下；声明的别人的凭据执行员取不到（另测）' },
  'GET /api/tasks': { ...LIST, echoes: ['vault'], why: '攻击方自己的任务里声明过受害者的保险箱 id（攻击时自己提交的），列表回显的是这个值；凭据本身取不到（另测）' },
  'GET /api/tasks/:id': NF,
  'POST /api/tasks/:id/cancel': NF,
  'GET /api/executor-allowlist': { status: 200, why: '只回自己' },
  'PUT /api/executor-allowlist': { status: 200, why: '按账号存' },
  'GET /api/executors': LIST,
  'GET /api/memory': LIST,
  'GET /api/memory/:topic': NF,
  'PUT /api/memory/:topic': { status: 200, why: '主题名按账号分命名空间：写的是攻击方自己的同名主题' },
  'DELETE /api/memory/:topic': { ...NF, why: '主题名按账号分命名空间：攻击前 ATTACK_PREP 先删掉攻击方自己的同名主题，所以确定是 404（和不存在的主题名一样）' },
  'GET /api/memory/:topic/versions': NF,
  'POST /api/memory/:topic/rollback': NF,
  'GET /api/library': LIST,
  'GET /api/library/:id': NF,
  'POST /api/library': { status: 201, why: '建在自己名下' },
  'DELETE /api/library/:id': NF,
  'GET /api/mcp/config': { status: 200, why: '只回自己' },
  'GET /api/capabilities': LIST,
  'PUT /api/capabilities/:id/trial': { status: 200, why: '能力 id 是全站目录；试用到期日按账号存' },
  'GET /api/inbox': LIST,
  'GET /api/inbox/unread-count': { status: 200, why: '只数自己的' },
  'GET /api/members': LIST,
  'POST /api/members': { status: 201, why: '建在自己名下' },
  'PATCH /api/members/:id': NF,
  'DELETE /api/members/:id': NF,
  'POST /api/members/:id/restore': NF,
  'PUT /api/members/:id/pin': NF,
  'DELETE /api/members/:id/pin': NF,
  'PUT /api/members/order': { status: 400, code: 'INVALID_ORDER' },
  'GET /api/settings/lead': { status: 200, why: '只回自己' },
  'PUT /api/settings/lead': { status: 400, code: 'MEMBER_NOT_FOUND' },
  'GET /api/usage': { status: 200, why: '只回自己' },
  'GET /api/members/:id/card': NF,
  'PUT /api/usage/limits/:memberId': NF,
  'GET /api/conversations': LIST,
  'POST /api/conversations': { status: 201, why: '建在自己名下' },
  'GET /api/search': LIST,
  'GET /api/conversations/:id': NF,
  'PATCH /api/conversations/:id': NF,
  'POST /api/conversations/:id/read': NF,
  'GET /api/conversations/:id/messages': NF,
  'POST /api/chat/stream': { status: 401, code: 'SESSION_REQUIRED', why: '令牌一律 401；Cookie 会话另测（别人的会话 id → 404）' },
  'GET /api/keys': LIST,
  'POST /api/keys': { status: 201, why: '建在自己名下' },
  'PATCH /api/keys/:id': NF,
  'DELETE /api/keys/:id': NF,
};
/** 小号的全范围客户端令牌打客户端能进的路由（其余路由一律 403） */
const CLIENT: Record<string, Exp> = {
  'GET /api/clients/self': { status: 200, why: '只回自己' },
  'POST /api/executor/hello': { status: 200, why: '登记自己的设备' },
  'POST /api/executor/tasks/claim': { status: 204, why: '攻击前 ATTACK_PREP 先领光攻击方自己的任务，受害者待领的任务一个都不许领到' },
  'POST /api/executor/tasks/:id/progress': { status: 404, code: 'TASK_NOT_FOUND' },
  'POST /api/executor/tasks/:id/result': { status: 404, code: 'TASK_NOT_FOUND' },
  'POST /api/executor/tasks/:id/secret': { status: 404, code: 'TASK_NOT_FOUND' },
  'POST /api/executor/tasks/:id/takeover': { status: 404, code: 'TASK_NOT_FOUND' },
  'GET /api/executor/tasks/:id/takeover/:tid': { status: 404, code: 'TASK_NOT_FOUND' },
  'GET /api/memory': LIST,
  'GET /api/memory/:topic': NF,
  'GET /api/library': LIST,
  'GET /api/library/:id': NF,
  'POST /api/library': { status: 201, why: '建在自己名下' },
};

/** 改动后会让攻击方自己的会话 / 令牌失效的路由：放到最后打 */
const SELF_ENDING = ['POST /api/clients/revoke-all', 'POST /api/auth/logout', 'POST /api/auth/logout-all', 'POST /api/auth/password'];

const key = (r: Pick<SeenRoute, 'method' | 'url'>) => `${r.method} ${r.url}`;
const uniq = (rs: SeenRoute[]) => [...new Map(rs.map((r) => [key(r), r])).values()];
const apiRoutes = () => uniq(seenRoutes.filter((r) => r.url.startsWith('/api/')));
const paramKinds = (url: string): string[] =>
  [...url.matchAll(/([^/]+)\/(:[A-Za-z_]+)/g)].map((m) => PARAM_KIND[`${m[1]}/${m[2]}`] ?? `?${m[1]}/${m[2]}`);
const fill = (url: string, ids: Ids): string =>
  url.replace(/([^/]+)\/(:[A-Za-z_]+)/g, (_s, seg: string, p: string) => `${seg}/${encodeURIComponent(ids[PARAM_KIND[`${seg}/${p}`] ?? ''] ?? MISSING_UUID)}`);
const isOwnerOnly = (r: SeenRoute) => r.config.userRoute !== true || OWNER_ONLY_FOR_FAMILY.includes(key(r));
const clientCanEnter = (r: SeenRoute) =>
  r.config.clientSelf === true || r.config.clientMcp === true || (typeof r.config.clientScope === 'string' && (CLIENT_SCOPES as readonly string[]).includes(r.config.clientScope));
/** 只有设备 / 客户端令牌能用的路由（执行员、clients/self）：正向对照用受害者自己的客户端令牌 */
const clientOnly = (r: SeenRoute) => r.config.userRoute !== true && clientCanEnter(r);
const statusOk = (e: Exp, s: number) => e.status === s;

// —— 泄露检查（必改 5）——
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** base64 / base64url 里一个字符串的稳定片段（3 种错位都算；去掉受前后字节影响的头尾 4 个字符） */
const b64Fragments = (s: string): string[] =>
  [0, 1, 2].flatMap((k) => {
    const enc = Buffer.from('xx'.slice(0, k) + s).toString('base64').replace(/=+$/, '');
    const mid = enc.slice(k ? 4 : 0, enc.length - 4);
    return [mid, mid.replace(/\+/g, '-').replace(/\//g, '_')];
  });
/** 收集一个 JSON 值里的全部字符串叶子（会把 \u 转义还原） */
const leaves = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
  return out;
};
const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const tryUri = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
/** 响应里所有能藏数据的地方：正文、响应头（Location / ETag / Content-Disposition…）、SSE 每条 data、JSON 叶子、URL 解码、base64 解码 */
function haystack(res: Pick<Inject, 'body' | 'headers'>): { all: string; short: string[] } {
  const raw = [res.body, ...Object.entries(res.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '')}`)];
  const strs = [...leaves(tryJson(res.body))];
  for (const line of res.body.split('\n')) if (line.startsWith('data:')) leaves(tryJson(line.slice(5).trim()), strs);
  const parts = [...raw, ...strs].flatMap((s) => [s, tryUri(s)]);
  // base64 解码：每个像 base64 的片段按 4 种对齐方式各解一次（必改 5：检查前先解码）
  for (const tok of parts.join('\n').match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []) {
    for (let k = 0; k < 4; k++) parts.push(Buffer.from(tok.slice(k), 'base64').toString('latin1'));
  }
  return { all: parts.join('\n').toLowerCase(), short: strs.filter((s) => s.length <= 24).map((s) => s.toLowerCase()) };
}
const NEEDLES: Record<Victim, string[]> = Object.fromEntries(
  (['owner', 'b'] as const).map((v) => {
    const plain = [MARK[v], apiKeyOf(v), secretOf(v)];
    return [v, [...plain, ...plain.map(sha256), ...plain.flatMap(b64Fragments)].map((s) => s.toLowerCase())];
  }),
) as Record<Victim, string[]>;
/** 受害者数据出现在响应里（明文 / 大小写 / base64 / URL 编码 / sha256 / 掩码后 4 位 / 响应头 / SSE） */
function leakedIn(res: Pick<Inject, 'body' | 'headers'>): Victim[] {
  const h = haystack(res);
  return (['owner', 'b'] as const).filter((v) => NEEDLES[v].some((n) => h.all.includes(n)) || h.short.some((s) => s.endsWith(TAIL[v])));
}

describe.each(envs)('#176 跨账号越权遍历 [$name]', (env) => {
  let t: AssistantEnv;
  const headers: Record<Who, Record<string, string>> = { owner: ownerAuth, b: {}, xiao: {}, xiaoClient: {}, xiaoCookie: {}, ownerClient: {}, bClient: {}, bCookie: {}, fresh: {} };
  const ids: Record<Victim | 'xiao' | 'missing', Ids> = { owner: {}, b: {}, xiao: {}, missing: {} };
  /** 攻击方以外各身份发的客户端令牌 id（快照时排除攻击方自己的行） */
  const xiaoClientIds: string[] = [];
  /** *Client 身份的设备令牌（tasks:pull + tasks:secret）：只用于 /api/executor/*（#376 M4 拆成两枚令牌） */
  const deviceHeaders: Partial<Record<Who, Record<string, string>>> = {};
  let seq = 0;
  const nonce = () => `n${(++seq).toString(36)}`;
  /** 每个凭据发了多少请求（auth/plugin.ts 按凭据限速 1200 次 / 分钟；遍历里攻击方会话要换新会话，见 run） */
  const sent: Partial<Record<Who, number>> = {};
  const call = (who: Who, method: string, url: string, payload?: object, extra?: Record<string, string>): Promise<Inject> => {
    sent[who] = (sent[who] ?? 0) + 1;
    const h = (url.startsWith('/api/executor/') && deviceHeaders[who]) || headers[who];
    return t.app.inject({ method, url, headers: { ...h, ...(extra ?? {}) }, ...(payload !== undefined ? { payload } : {}) } as InjectOptions);
  };
  const confirmToken = async (who: Who, res428: Inject): Promise<string> => {
    const ch = res428.json().error.confirm as { stepUrl: string };
    expect((await call(who, 'POST', ch.stepUrl, { step: 1 })).statusCode).toBe(200);
    t.clock.advance(3000);
    const s2 = await call(who, 'POST', ch.stepUrl, { step: 2 });
    expect(s2.statusCode, s2.body).toBe(200);
    return s2.json().confirmToken as string;
  };
  /** 遇到重要确认（428）就由本人走完两步，带确认令牌重发 */
  const confirmed = async (who: Who, method: string, url: string, payload?: object, extra?: Record<string, string>): Promise<Inject> => {
    const first = await call(who, method, url, payload, extra);
    if (first.statusCode !== 428) return first;
    const token = await confirmToken(who, first);
    return call(who, method, url, { ...(payload ?? {}), confirmToken: token }, extra);
  };
  /** 建一份资源；失败直接报（夹具坏了要看得见），返回 json */
  const make = async (who: Who, method: string, url: string, payload?: object): Promise<Json> => {
    const r = await confirmed(who, method, url, payload);
    expect(r.statusCode, `${who} ${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`).toBeLessThan(300);
    return r.body ? (r.json() as Json) : {};
  };
  const clientOf = (v: Victim): Who => (v === 'owner' ? 'ownerClient' : 'bClient');
  const login = async (email: string, password: string, cookie = false): Promise<Record<string, string>> => {
    const r = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, ...(cookie ? { cookie: true } : {}) } });
    expect(r.statusCode, r.body).toBe(200);
    return cookie ? { cookie: String(r.headers['set-cookie']).split(';')[0]!, ...CSRF } : { authorization: `Bearer ${r.json().token as string}` };
  };
  /** 一次性家人账号（正向对照里会结束自己会话 / 改自己密码 / 被停用的那些路由用） */
  const freshUser = async (): Promise<{ id: string; email: string; pw: string }> => {
    const n = nonce();
    const email = `fresh-${n}-176@example.test`;
    const pw = fakePw(500 + seq);
    const { userId } = await seedXiaohao(t.deps.users, { email, password: pw, displayName: `fresh${n}` }, t.clock.now);
    return { id: userId, email, pw };
  };
  const memberStore = (v: Victim) => (v === 'owner' ? t.deps.members : t.deps.members.forUser(ids.b.user!));
  /** 负责人要有模型能力信息才能当（PUT /api/settings/lead 的前提） */
  const makeEligible = async (v: Victim, id: string) => {
    const m = (await memberStore(v).get(id))!;
    await memberStore(v).update({ ...m, modelCaps: { mode: 'chat', maxInputTokens: 128000, supportsTools: true, checkedAt: t.clock.now().toISOString() } });
  };
  const newMember = async (v: Victim): Promise<string> => (await make(v, 'POST', '/api/members', { name: `${MARK[v]}sp${nonce()}` })).member.id as string;
  /** 受害者的执行员领到一个任务（任务声明了自己的保险箱条目），返回任务 id */
  const claimedTask = async (v: Victim): Promise<string> => {
    const id = (await make(v, 'POST', '/api/tasks', { kind: 'browse', site: `https://${MARK[v]}.example.test`, instruction: `${MARK[v]} task`, secrets: [{ secretId: ids[v].vault, field: 'value' }] })).task.id as string;
    for (let k = 0; k < 30; k++) {
      const c = await call(clientOf(v), 'POST', '/api/executor/tasks/claim', { waitSec: 0 });
      expect(c.statusCode, c.body).toBeLessThan(300);
      if ((c.body ? (c.json() as Json).task?.id : undefined) === id) return id;
      if (c.statusCode === 204) break;
    }
    throw new Error(`${v} 的执行员领不到任务 ${id}`);
  };
  const takeoverOn = async (v: Victim, task: string): Promise<string> =>
    (await make(clientOf(v), 'POST', `/api/executor/tasks/${task}/takeover`, { reason: 'x', message: `${MARK[v]} takeover` })).takeover?.id ?? (await make(v, 'GET', `/api/tasks/${task}/takeovers`)).takeovers[0].id;
  const newInboxCard = async (v: Victim): Promise<string> => {
    const card = { id: randomUUID(), group: 'decision' as const, kind: `k176${nonce()}`, urgency: 'normal' as const, title: `${MARK[v]} inbox`, summary: `${MARK[v]} summary`, related: { type: 'task', id: ids[v].task ?? MISSING_UUID }, actions: [{ id: 'ok', label: 'OK', kind: 'ack' }], status: 'open' as const, createdAt: t.clock.now() };
    return (await t.deps.inbox.insertDedup(v === 'owner' ? card : ({ ...card, userId: ids.b.user! } as never))).item.id as string;
  };
  const newAssistant = async (): Promise<string> => (await make('owner', 'POST', '/api/assistants', BODIES['POST /api/assistants']!('owner', ids.owner, nonce())!)).assistant.id as string;

  async function seed(v: Victim): Promise<void> {
    const m = MARK[v];
    const i = ids[v];
    i.member = (await make(v, 'POST', '/api/members', { name: `${m}bot` })).member.id;
    // 成员要有部署（Key）才能进助手 / 当负责人
    await addDeployment(t, `${m}bot`, 'groq/gpt-oss-120b', v === 'owner' ? undefined : ids.b.user);
    i.memory = `topic-${v}`; // 主题名不带标记：攻击方在自己名下建同名主题、回显主题名不算泄露
    await make(v, 'PUT', `/api/memory/${i.memory}`, { title: `${m} topic`, body: `${m} memory body` });
    i.library = (await make(v, 'POST', '/api/library', { kind: 'idea', title: `${m} note`, body: `${m} body` })).item.id;
    // 保险箱的值、Key 都带「后 4 位」标记：掩码显示时也认得出
    i.vault = (await make(v, 'POST', '/api/vault', { name: `${m}vault`, kind: 'password', value: secretOf(v) })).secret.id;
    i.key = (await make(v, 'POST', '/api/keys', { name: `${m}key`, sourceUrl: 'https://example.test', apiKey: apiKeyOf(v), model: 'openai/gpt-4o-mini' })).key.id;
    // 家人账号登记 HTTP 工具要所有者本人确认（D251），B 没有：给一个 B 名下不存在的工具名（攻击时和不存在的结果应一样）
    i.httpTool = v === 'owner' ? (await make(v, 'PUT', '/api/gateway/http-tools', { def: { toolId: `${m}tool`, name: `${m}tool`, baseUrl: 'https://api.example.test', allowedHosts: ['api.example.test'], risk: 'read' } })).tool.toolId : `${m}tool`;
    i.conversation = (await make(v, 'POST', '/api/conversations', { title: `${m} conv` })).conversation.id;
    const own = await make(v, 'POST', '/api/clients', { name: `${m} client`, scopes: ['library:read'] });
    i.client = own.client.id;
    await make(v, 'PUT', '/api/executor-allowlist', { sites: [`https://${m}.example.test`] });
    await makeEligible(v, i.member!);
    await make(v, 'PUT', '/api/settings/lead', { leadId: i.member });
    await make(v, 'PUT', `/api/usage/limits/${i.member}`, { dailyLimit: 7 });
    await make(v, 'PUT', `/api/memory/${i.memory}`, { title: `${m} topic v2`, body: `${m} memory body v2` }); // 有第 1 版可回滚
    await make(v, 'PUT', '/api/interrupt-budget', { daily: 5 });
    i.capability = TRIAL_CAP;
    await make(v, 'PUT', `/api/capabilities/${i.capability}/trial`, { endsAt: '2027-03-01' });
    // 受害者自己的两枚客户端令牌（非执行员全范围 + 设备令牌）+ 执行员：主任务已被受害者的执行员领走、并且挂了一张接管卡（攻击时 task / takeover 都是真的）
    headers[clientOf(v)] = { authorization: `Bearer ${(await make(v, 'POST', '/api/clients', { name: `${m} all`, scopes: NON_EXECUTOR_SCOPES, rateLimitPerMin: 6000 })).token as string}` };
    deviceHeaders[clientOf(v)] = { authorization: `Bearer ${(await make(v, 'POST', '/api/clients', { name: `${m} device`, scopes: [...EXECUTOR_SCOPES], rateLimitPerMin: 6000 })).token as string}` };
    await make(clientOf(v), 'POST', '/api/executor/hello', { deviceName: `${m}dev`, platform: 'p', version: '1' });
    i.task = await claimedTask(v);
    i.takeover = await takeoverOn(v, i.task);
    // 收件箱卡片（所有者走接口；账号没有发卡接口，直接写库，和后台任务给账号发卡一样）
    i.inbox = await newInboxCard(v);
    i.action = 'ok';
    if (v === 'owner') {
      // 只给所有者的功能：助手（含一次运行）、作品项目（含一个版本）、确认卡
      i.assistant = await newAssistant();
      i.run = (await make('owner', 'POST', `/api/assistants/${i.assistant}/runs`)).run.id;
      await t.app.assistants.runner.idle();
      i.project = (await make('owner', 'POST', '/api/work/projects', { name: `${m} project` })).project.id;
      await t.deps.work.addVersions('owner', i.project!, [{ sourceType: 'github_release', sourceRef: `${m}-v1`, label: 'v1', title: `${m} release`, actor: null, artifacts: [], sourceState: 'published', sourceAt: t.clock.now() }], t.clock.now());
      i.version = (await make('owner', 'GET', `/api/work/projects/${i.project}/versions`)).versions[0].id;
      i.confirm = await newChallenge();
      await make('owner', 'POST', '/api/users/invites', { email: `${m}-invite@example.test` });
      // 推送订阅只给所有者：攻击前得有一行，快照才真的盖住 push_subscriptions
      await make('owner', 'POST', '/api/push/subscriptions', BODIES['POST /api/push/subscriptions']!('owner', {}, 'seed')!);
    } else {
      i.user = ids.b.user!;
    }
  }
  /** 所有者触发一次重要确认（删一个备用保险箱条目），返回确认卡 id */
  const newChallenge = async (): Promise<string> => {
    const spare = (await make('owner', 'POST', '/api/vault', { name: `${MARK.owner}spv${nonce()}`, kind: 'note', value: 'spare' })).secret.id as string;
    const r = await call('owner', 'DELETE', `/api/vault/${spare}`, {});
    expect(r.statusCode, r.body).toBe(428);
    return /\/api\/confirm\/([^/]+)\/steps/.exec((r.json().error.confirm as { stepUrl: string }).stepUrl)![1]!;
  };

  beforeAll(async () => {
    t = await assistantEnv(
      { name: env.name, make: async (now) => ({ ...(await env.make(now)), pushFetch: (async () => new Response(null, { status: 201 })) as typeof fetch }) },
      // CORE_JOBS=off：twoAccounts 默认会启动进程内定时任务（首跑 60 秒后），慢机器上 Key 对账 / 模型能力刷新会在攻击中途改所有者的行、弄脏数据库快照
      { extraEnv: { CORE_JOBS: 'off', CORE_CHAT_TOKEN: CHAT_TOKEN, VAULT_KEY: randomBytes(32).toString('base64'), PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:owner@example.test' } },
    );
    headers.xiao = t.xiaoHeaders;
    ids.xiao.user = t.xiaoId;
    const b = await seedXiaohao(t.deps.users, { email: B_EMAIL, password: B_PW, displayName: `${MARK.b}user` }, t.clock.now);
    ids.b.user = b.userId;
    headers.b = await login(B_EMAIL, B_PW);
    headers.bCookie = await login(B_EMAIL, B_PW, true);
    headers.xiaoCookie = await login('xiaohao@example.test', XIAOHAO_TEST_PASSWORD, true);
    await seed('owner');
    await seed('b');
    for (const k of Object.values(PARAM_KIND)) ids.missing[k] = MISSING_UUID;
    Object.assign(ids.missing, { member: 'missingbot', memory: 'topic-missing', httpTool: 'missingtool', capability: TRIAL_CAP, action: 'ok' });
    const xc = await make('xiao', 'POST', '/api/clients', { name: 'xiao all', scopes: NON_EXECUTOR_SCOPES, rateLimitPerMin: 6000 });
    const xd = await make('xiao', 'POST', '/api/clients', { name: 'xiao device', scopes: [...EXECUTOR_SCOPES], rateLimitPerMin: 6000 });
    xiaoClientIds.push(xc.client.id as string, xd.client.id as string);
    headers.xiaoClient = { authorization: `Bearer ${xc.token as string}` };
    deviceHeaders.xiaoClient = { authorization: `Bearer ${xd.token as string}` };
    await call('xiaoClient', 'POST', '/api/executor/hello', { deviceName: 'xiaodev', platform: 'p', version: '1' });
  });
  afterAll(async () => {
    await t?.closeAll();
  });

  // ———————————————————— 正向对照（必改 1）————————————————————

  interface Pos {
    /** 对哪些受害者做正向对照（默认：家人能用的路由 owner + b；只给所有者的 owner） */
    victims?: Victim[];
    /** 少了某个受害者的理由 */
    why?: string;
    /** 用谁的凭据（默认：受害者本人；只给设备的路由用受害者的客户端令牌） */
    as?: (v: Victim) => Who;
    /** 先准备好状态（备用资源、前置步骤），返回覆盖的 id */
    prep?: (v: Victim) => Promise<Ids | void>;
    /** 换掉请求体（只在请求体必须带本人的完整列表等时用） */
    body?: (v: Victim) => Promise<object>;
    after?: () => Promise<void>;
  }
  const spare = (kind: string, fn: (v: Victim) => Promise<string>) => async (v: Victim) => ({ [kind]: await fn(v) });
  const asFresh = async () => {
    const u = await freshUser();
    headers.fresh = await login(u.email, u.pw);
    PW.fresh = u.pw;
  };
  let release: (() => void) | undefined;
  const POSITIVE: Record<string, Pos> = {
    'DELETE /api/assistants/:id': { prep: spare('assistant', newAssistant) },
    'POST /api/assistants/:id/resume': { prep: async () => void (await make('owner', 'POST', `/api/assistants/${ids.owner.assistant}/pause`)) },
    'POST /api/assistants/:id/runs/:run/cancel': {
      // 让运行卡在调用模型上（gate），才能取消
      prep: async () => {
        t.gw.gate = new Promise<void>((r) => (release = r));
        // 用没设每日上限的成员（种子里的上限会让运行因预算直接结束，取消不了）
        const assistant = (await make('owner', 'POST', '/api/assistants', baseBody({ name: `${MARK.owner} gated ${nonce()}` }))).assistant.id as string;
        return { assistant, run: (await make('owner', 'POST', `/api/assistants/${assistant}/runs`)).run.id as string };
      },
      after: async () => {
        release?.();
        t.gw.gate = null;
        await t.app.assistants.runner.idle();
      },
    },
    'DELETE /api/clients/:id': { prep: spare('client', async (v) => (await make(v, 'POST', '/api/clients', { name: `${MARK[v]} spare`, scopes: ['library:read'] })).client.id) },
    'PUT /api/gateway/http-tools': { victims: ['owner'], why: '家人登记 HTTP 工具要所有者本人确认（D251），B 拿到 403 是设计如此' },
    'DELETE /api/gateway/http-tools/:id': {
      victims: ['owner'],
      why: 'B 名下没有 HTTP 工具（见上）',
      prep: spare('httpTool', async () => (await make('owner', 'PUT', '/api/gateway/http-tools', BODIES['PUT /api/gateway/http-tools']!('owner', {}, nonce()))).tool.toolId),
    },
    'POST /api/gateway/call': { victims: ['owner'], why: 'B 名下没有 HTTP 工具' },
    'DELETE /api/keys/:id': { prep: spare('key', async (v) => (await make(v, 'POST', '/api/keys', BODIES['POST /api/keys']!(v, {}, nonce()))).key.id) },
    'DELETE /api/library/:id': { prep: spare('library', async (v) => (await make(v, 'POST', '/api/library', { kind: 'idea', title: 'spare', body: 'spare' })).item.id) },
    'DELETE /api/members/:id': { prep: spare('member', newMember) },
    'POST /api/members/:id/restore': {
      prep: spare('member', async (v) => {
        const id = await newMember(v);
        await make(v, 'DELETE', `/api/members/${id}`);
        return id;
      }),
    },
    'POST /api/members/:id/purge': {
      prep: spare('member', async (v) => {
        const id = await newMember(v);
        await make(v, 'DELETE', `/api/members/${id}`);
        return id;
      }),
    },
    'POST /api/members/:id/onboard': {
      // 候选成员由后台发现流程直接写库（没有建候选的接口）
      prep: spare('member', async (v) => {
        const id = await newMember(v);
        const mem = (await memberStore(v).get(id))!;
        await memberStore(v).update({ ...mem, status: 'candidate' });
        return id;
      }),
    },
    'DELETE /api/members/:id/pin': {
      prep: spare('member', async (v) => {
        const id = await newMember(v);
        await make(v, 'PUT', `/api/members/${id}/pin`);
        return id;
      }),
    },
    'PUT /api/members/order': { body: async (v) => ({ ids: ((await make(v, 'GET', '/api/members')).members as { id: string }[]).map((x) => x.id) }) },
    'PUT /api/settings/lead': { prep: async (v) => makeEligible(v, ids[v].member!) },
    'DELETE /api/memory/:topic': { prep: spare('memory', async (v) => { const tp = `spare-${nonce()}`; await make(v, 'PUT', `/api/memory/${tp}`, { title: 'spare', body: 'spare' }); return tp; }) },
    'DELETE /api/vault/:id': {
      victims: ['owner'],
      why: '家人删保险箱条目要所有者本人确认（重要确认），B 拿到 403 是设计如此',
      prep: spare('vault', async () => (await make('owner', 'POST', '/api/vault', { name: `${MARK.owner}spv${nonce()}`, kind: 'note', value: 'spare' })).secret.id),
    },
    'POST /api/vault/:id/reveal': { victims: ['owner'], why: '家人查看明文要所有者本人确认，B 拿到 403 是设计如此' },
    'POST /api/tasks/:id/cancel': { prep: spare('task', async (v) => (await make(v, 'POST', '/api/tasks', { kind: 'browse', site: `https://${MARK[v]}.example.test` })).task.id) },
    'POST /api/tasks/:id/takeovers/:tid/resolve': {
      prep: async (v) => {
        const task = await claimedTask(v);
        return { task, takeover: await takeoverOn(v, task) };
      },
    },
    'POST /api/executor/tasks/:id/progress': { prep: spare('task', claimedTask) },
    'POST /api/executor/tasks/:id/result': { prep: spare('task', claimedTask) },
    'POST /api/executor/tasks/:id/secret': { prep: spare('task', claimedTask) },
    'POST /api/executor/tasks/:id/takeover': { prep: spare('task', claimedTask) },
    'POST /api/confirm/:id/steps': { prep: spare('confirm', newChallenge) },
    'POST /api/inbox/:id/actions/:actionId': { prep: spare('inbox', newInboxCard) },
    'POST /api/inbox/:id/dismiss': { prep: spare('inbox', newInboxCard) },
    'POST /api/inbox/dismiss': { prep: spare('inbox', newInboxCard) },
    'POST /api/users/:id/disable': { prep: spare('user', async () => (await freshUser()).id) },
    'POST /api/users/:id/enable': {
      prep: spare('user', async () => {
        const u = await freshUser();
        await make('owner', 'POST', `/api/users/${u.id}/disable`);
        return u.id;
      }),
    },
    'POST /api/users/:id/reset-link': { prep: spare('user', async () => (await freshUser()).id) },
    'POST /api/push/subscriptions/remove': { body: async () => { const n = nonce(); await make('owner', 'POST', '/api/push/subscriptions', BODIES['POST /api/push/subscriptions']!('owner', {}, n)!); return BODIES['POST /api/push/subscriptions/remove']!('owner', {}, n)!; } },
    'POST /api/chat/stream': { victims: ['b'], why: '所有者令牌一律 401（只认账号 Cookie 会话；CORE_OWNER_ACCOUNT_ID 映射另有测试）', as: () => 'bCookie' },
    // 会结束本人会话 / 吊销本人全部令牌 / 改本人密码的：用一次性家人账号做
    'POST /api/auth/logout': { victims: ['b'], why: '会结束本人会话：用一次性家人账号', as: () => 'fresh', prep: asFresh },
    'POST /api/auth/logout-all': { victims: ['b'], why: '同上', as: () => 'fresh', prep: asFresh },
    'POST /api/auth/password': { victims: ['b'], why: '同上', as: () => 'fresh', prep: asFresh },
    'POST /api/clients/revoke-all': { victims: ['b'], why: '会吊销本人全部令牌：用一次性家人账号', as: () => 'fresh', prep: asFresh },
  };
  const posVictims = (r: SeenRoute): Victim[] => POSITIVE[key(r)]?.victims ?? (isOwnerOnly(r) && !clientOnly(r) ? ['owner'] : ['owner', 'b']);
  const posActor = (r: SeenRoute, v: Victim): Who => POSITIVE[key(r)]?.as?.(v) ?? (clientOnly(r) ? clientOf(v) : v);

  // ———————————————————— 攻击 ————————————————————

  type Attacker = 'xiao' | 'xiaoClient';
  /** 攻击方以 victim 的 id / 请求体打一条路由（请求体用攻击方自己的标记：自己建的东西回显不算泄露；引用的 id 换成受害者的） */
  const attack = (r: SeenRoute, victim: Victim | 'missing', attacker: Attacker, n = nonce(), extra?: { headers?: Record<string, string>; query?: string; body?: object }): Promise<Inject> => {
    const base = r.method === 'GET' ? undefined : BODIES[key(r)]?.('xiao', ids[victim], n);
    const body = extra?.body && (base === undefined || typeof base === 'object') ? { ...(base ?? {}), ...extra.body } : base;
    const q = QUERY[key(r)]?.(victim === 'missing' ? 'xiao' : victim) ?? '';
    const url = fill(r.url, ids[victim]) + q + (extra?.query ? (q ? '&' : '?') + extra.query : '');
    // 遇到重要确认，攻击方自己把两步点完再重发（攻击方能确认自己的挑战；确认令牌必须绑定账号和这次操作）
    return (attacker === 'xiao' ? confirmed : call)(attacker, r.method, url, body, extra?.headers);
  };
  const errCode = (r: Inject): string | null => {
    try {
      return (r.json() as { error?: { code?: string } }).error?.code ?? null;
    } catch {
      return null;
    }
  };
  /**
   * 第 2 轮必改 1：只认 schema 校验产生的 400。http/errors.ts 里只有 Fastify 校验分支回 { code: 'BAD_REQUEST', fields: [...] }；
   * 处理器用 badRequest() 抛的业务 400 也叫 BAD_REQUEST，但没有 fields，所以按 fields 区分（不只看错误码）。
   */
  const isSchema400 = (r: Inject): boolean => {
    if (r.statusCode !== 400) return false;
    try {
      const e = (r.json() as { error?: { code?: string; fields?: unknown } }).error;
      return e?.code === 'BAD_REQUEST' && Array.isArray(e.fields);
    } catch {
      return false;
    }
  };
  /**
   * 必改 5：攻击前把攻击方自己的状态摆到确定的样子，期望才能钉成单值（不依赖路由遍历的先后顺序）。
   * 每个攻击请求（含不存在 id 的对照、三种注入）之前都跑一次。
   */
  const ATTACK_PREP: Record<string, () => Promise<void>> = {
    // 主题名按账号分命名空间：前面 PUT 的攻击会在攻击方自己名下建同名主题。先删掉，DELETE 的攻击结果就确定是 404（和受害者有没有无关）
    'DELETE /api/memory/:topic': async () => {
      for (const tp of [ids.owner.memory!, ids.b.memory!, ids.missing.memory!]) await call('xiao', 'DELETE', `/api/memory/${tp}`);
    },
    // 先把攻击方自己名下的任务领光，claim 的攻击结果就确定是 204；领光的过程中也不许领到受害者的任务
    'POST /api/executor/tasks/claim': async () => {
      for (let k = 0; k < 100; k++) {
        const c = await call('xiaoClient', 'POST', '/api/executor/tasks/claim', { waitSec: 0 });
        if (leakedIn(c).length) throw new Error(`领光攻击方任务时领到了别人的任务：${c.body.slice(0, 200)}`);
        if (c.statusCode === 204) return;
        if (c.statusCode !== 200) throw new Error(`领任务 → ${c.statusCode} ${c.body.slice(0, 200)}`);
      }
      throw new Error('攻击方名下的任务领不完');
    },
  };
  /** 受害者全部资源 id（列表接口的「空结果」判定：攻击方的列表里一个都不能有）。主题名、能力 id、动作名是命名空间 / 目录，不算 */
  const victimIds = (v: Victim, echoes: string[] = []) => Object.entries(ids[v]).filter(([k]) => !['memory', 'capability', 'action', 'httpTool', ...echoes].includes(k));

  // ———————————————————— 数据库快照（必改 4）————————————————————

  /**
   * 易变字段白名单：只有这里列的列不参与比对，每条写理由。
   * 受害者自己的行在攻击期间本来什么都不该变，所以目前为空；真要加必须写清楚为什么攻击方的请求会合理地改到它。
   */
  const VOLATILE: Record<string, string> = {};
  /**
   * 必改 2：快照逐表正向对照。攻击前每张表 owner 和 B 都要至少有一行，否则这张表其实没被快照覆盖（读不到时前后都是空、照样绿）→ 失败。
   * 按设计某一方不可能有行的，在这里逐表写理由；不再需要的豁免也会失败（免得白名单只增不减）。
   */
  const SNAPSHOT_SIDE_EXEMPT: Record<string, Partial<Record<Victim, string>>> = {
    core_schema_migrations: { owner: '迁移记录，不属于任何账号（整表照样参与比对）', b: '同左' },
    users: { owner: '所有者不在 users 表（所有者令牌认证）' },
    user_sessions: { owner: '所有者用所有者令牌，不建会话' },
    user_invites: { b: '只有所有者能发邀请 / 重置链接（按发起人 created_by 认）' },
    confirm_challenges: { b: '家人做不了重要确认（只有所有者有确认卡）' },
    assistants: { b: '助手只给所有者' },
    assistant_members: { b: '助手只给所有者' },
    assistant_runs: { b: '助手只给所有者' },
    run_steps: { b: '助手只给所有者' },
    work_projects: { b: '作品项目只给所有者' },
    work_versions: { b: '作品项目只给所有者' },
    push_subscriptions: { b: '推送只给所有者' },
  };
  /** 一行属于谁：user_invites 按发起人 created_by；有 user_id 列按它；users 按 id；审计按 actor_id；确认卡按 actor；设置按 key 前缀（u<去掉连字符的账号 id>.，没前缀 = 所有者） */
  const sideOf = (table: string, j: Record<string, unknown>): string | null => {
    const raw = table === 'user_invites' ? j.created_by : 'user_id' in j ? j.user_id : table === 'users' ? j.id : table === 'audit_log' ? j.actor_id : table === 'confirm_challenges' ? j.actor : table === 'core_settings' ? (/^u([0-9a-f]{32})\./.exec(String(j.key))?.[1] ?? 'owner') : null;
    if (raw == null) return null;
    const id = String(raw).replace(/-/g, '');
    return id === 'owner' ? 'owner' : id === ids.b.user!.replace(/-/g, '') ? 'b' : null;
  };
  interface DbSnap {
    rows: Record<string, string[]>;
    sides: Record<string, Record<Victim, number>>;
  }
  async function dbSnapshot(): Promise<DbSnap | null> {
    const db = t.deps.db;
    if (!db) return null;
    // 应用角色读全表：RLS 表用系统范围（只读策略），没开 RLS 的表应用角色本来就能读
    const sys = systemScoped(db);
    const tables = (await sys.query<{ t: string; uid: boolean }>(
      `SELECT c.relname AS t, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped) AS uid
         FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' ORDER BY 1`,
    )).rows;
    const victims = ['owner', ids.b.user!];
    // 攻击方的 id 也认不带连字符的写法（core_settings 的 key 是 u<去掉连字符的账号 id>.<设置名>）
    const attackerIds = [ids.xiao.user!, ids.xiao.user!.replace(/-/g, ''), ...xiaoClientIds];
    const out: DbSnap = { rows: {}, sides: {} };
    for (const { t: table, uid } of tables) {
      // user_invites：邀请行的 user_id 是空的（账号还没建），按发起人 created_by 认，否则所有者的邀请根本不在快照里
      const where = table === 'users' ? 'WHERE id::text = ANY($1)' : table === 'user_invites' ? 'WHERE user_id::text = ANY($1) OR created_by = ANY($1)' : uid ? 'WHERE user_id::text = ANY($1)' : table === 'audit_log' ? 'WHERE actor_id = ANY($1)' : '';
      const sides = { owner: 0, b: 0 };
      const rows = (await sys.query<{ j: Record<string, unknown> }>(`SELECT to_jsonb(x) AS j FROM ${table} x ${where}`, where ? [victims] : [])).rows.map((r) => {
        const j = typeof r.j === 'string' ? (JSON.parse(r.j) as Record<string, unknown>) : r.j;
        const side = sideOf(table, j);
        if (side) sides[side as Victim]++;
        for (const col of Object.keys(j)) if (`${table}.${col}` in VOLATILE) delete j[col];
        return JSON.stringify(j);
      });
      // 没有 user_id 列的表（确认卡、设置…）：除了明确属于攻击方的行，全部纳入
      out.rows[table] = rows.filter((s) => uid || where || !attackerIds.some((a) => s.includes(a))).sort();
      out.sides[table] = sides;
    }
    return out;
  }
  /** 逐表正向对照的问题清单（空 = 每张表 owner / B 都有行，或写了豁免理由） */
  const sideGaps = (snap: DbSnap): string[] => [
    ...Object.entries(snap.sides).flatMap(([table, n]) =>
      (['owner', 'b'] as const).flatMap((v) => {
        const exempt = SNAPSHOT_SIDE_EXEMPT[table]?.[v];
        if (n[v] === 0 && !exempt) return [`${table}：攻击前 ${v} 一行都没有（这张表没被快照真正覆盖；补 seed，或在 SNAPSHOT_SIDE_EXEMPT 写理由）`];
        if (n[v] > 0 && exempt) return [`${table}：${v} 有 ${n[v]} 行，SNAPSHOT_SIDE_EXEMPT 里的豁免已不需要，删掉`];
        return [];
      }),
    ),
    ...Object.keys(SNAPSHOT_SIDE_EXEMPT).filter((tb) => !(tb in snap.sides)).map((tb) => `SNAPSHOT_SIDE_EXEMPT 里的 ${tb} 表已不存在`),
  ];
  /**
   * 内存存储没有表可查：退回到受害者用自己的身份把全部读接口读一遍（只在 memory 环境用）。
   * 已知局限：这不是数据库快照。越权写只要不在任何读接口里回显（或回显被别的字段盖住），内存存储就抓不到；
   * 所以「越权写」的自证（self-check/interrupt-budget-cross-write.patch）只要求 pglite-app-role / postgres-app-role 被快照抓到。
   */
  async function apiSnapshot(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const v of ['owner', 'b'] as const) {
      for (const r of apiRoutes().filter((x) => x.method === 'GET' && key(x) !== 'GET /api/audit' && !clientOnly(x))) {
        const res = await call(v, 'GET', fill(r.url, ids[v]) + (QUERY[key(r)]?.(v) ?? ''));
        out[`${v} ${key(r)}`] = [`${res.statusCode} ${res.body}`];
      }
    }
    return out;
  }
  const snapshot = async (): Promise<Record<string, string[]>> => (await dbSnapshot())?.rows ?? apiSnapshot();
  const diff = (a: Record<string, string[]>, b: Record<string, string[]>): string[] =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => {
      const x = a[k] ?? [];
      const y = b[k] ?? [];
      const gone = x.filter((s) => !y.includes(s));
      const added = y.filter((s) => !x.includes(s));
      return gone.length || added.length ? [`${k}\n  少了：${gone.join('\n        ').slice(0, 600)}\n  多了：${added.join('\n        ').slice(0, 600)}`] : [];
    });

  // ———————————————————— 测试 ————————————————————

  it('覆盖：每条路由都登记了参数类别、请求体、攻击期望和正向对照；路由数不少于快照；泄露检查认得出各种变形', () => {
    const all = apiRoutes();
    expect(all.length, '路由数比快照少：有路由被 flag / 环境变量关掉，没被遍历到').toBeGreaterThanOrEqual(MIN_API_ROUTES);
    const unknownParams = all.flatMap((r) => paramKinds(r.url).filter((k) => k.startsWith('?')).map((k) => `${key(r)} ${k}`));
    expect(unknownParams, '新路由的路径参数要在 PARAM_KIND 里登记').toEqual([]);
    expect(all.filter((r) => r.method !== 'GET' && !(key(r) in BODIES)).map(key), '新改动类路由要在 BODIES 里给一份能过校验的请求体').toEqual([]);
    expect(Object.keys(BODIES).filter((k) => !all.some((r) => key(r) === k)), 'BODIES 里有已经不存在的路由').toEqual([]);
    for (const k of OWNER_ONLY_FOR_FAMILY) expect(all.some((r) => key(r) === k), k).toBe(true);
    // 家人能用的路由（含不带参数的 GET 列表接口——批量泄露的主入口）都要逐条声明攻击期望
    expect(all.filter((r) => !isOwnerOnly(r) && !(key(r) in FAMILY)).map(key), '家人能用的路由要在 FAMILY 里声明攻击方的期望').toEqual([]);
    expect(Object.keys(FAMILY).filter((k) => !all.some((r) => key(r) === k && !isOwnerOnly(r))), 'FAMILY 里有不存在 / 只给所有者的路由').toEqual([]);
    expect(all.filter((r) => clientCanEnter(r) && r.url.startsWith('/api/') && !(key(r) in CLIENT)).map(key), '客户端令牌能进的路由要在 CLIENT 里声明期望').toEqual([]);
    expect(Object.keys(CLIENT).filter((k) => !all.some((r) => key(r) === k && clientCanEnter(r))), 'CLIENT 里有不存在 / 客户端进不去的路由').toEqual([]);
    expect(Object.keys(POSITIVE).filter((k) => !all.some((r) => key(r) === k)), 'POSITIVE 里有已经不存在的路由').toEqual([]);
    // 泄露检查自测：每种变形都要认得出（检查器本身失灵 = 全绿也说明不了什么）
    const h = (body: string, hd: Record<string, string> = {}) => leakedIn({ body, headers: hd });
    expect(h(`{"x":"${MARK.owner.toUpperCase()}"}`)).toEqual(['owner']);
    expect(h(`{"x":"${Buffer.from(`x:${secretOf('b')}`).toString('base64')}"}`)).toEqual(['b']);
    expect(h(`{"x":"zz${Buffer.from(`ab${MARK.owner}cd`).toString('base64url')}"}`)).toEqual(['owner']);
    expect(h('{}', { location: `/x/${encodeURIComponent(MARK.b)}` })).toEqual(['b']);
    expect(h('{}', { etag: `"${sha256(apiKeyOf('owner'))}"`, 'content-disposition': 'attachment' })).toEqual(['owner']);
    expect(h(`data: {"t":"${[...MARK.owner].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join('')}"}\n\n`)).toEqual(['owner']);
    expect(h(`{"last4":"••••${TAIL.b}"}`)).toEqual(['b']);
    expect(h(`{"name":"${MARK.xiao}","last4":"${TAIL.xiao}"}`)).toEqual([]);
  });

  it('正向对照：每条路由先由资源的主人用自己的凭据、自己的 id 打同一个请求，必须 2xx（没跑通 = 失败，不跳过）', async () => {
    const bad: string[] = [];
    let ran = 0;
    for (const r of apiRoutes()) {
      const spec = POSITIVE[key(r)] ?? {};
      for (const v of posVictims(r)) {
        const over = (await spec.prep?.(v)) ?? {};
        const i = { ...ids[v], ...over };
        const who = posActor(r, v);
        const body = r.method === 'GET' ? undefined : spec.body ? await spec.body(v) : BODIES[key(r)]?.(who === 'fresh' ? 'fresh' : who, i, nonce());
        const res = await confirmed(who, r.method, fill(r.url, i) + (QUERY[key(r)]?.(v) ?? ''), body);
        ran++;
        if (res.statusCode >= 300) bad.push(`${key(r)} [${v} as ${who}] → ${res.statusCode} ${res.body.slice(0, 160)}`);
        // 主人读自己的东西时，泄露检查器要能认出自己的标记（证明「没检出」不是因为看不见）
        if (key(r) === 'GET /api/vault' && !leakedIn(res).includes(v)) bad.push(`${key(r)} [${v}] 本人读自己的保险箱，检查器没认出标记`);
        await spec.after?.();
      }
    }
    expect(bad, '正向对照没走进处理器').toEqual([]);
    expect(ran).toBeGreaterThanOrEqual(MIN_API_ROUTES);
    await t.app.assistants.runner.idle();
  });

  it('非 /api 的接口（/v1、/internal）：家人会话令牌进不去；家人的 models:chat 客户端令牌只看得到自己的', async () => {
    const V1 = [
      ['GET', '/v1/models', undefined],
      ['POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }],
      ['POST', '/v1/responses', { input: 'x' }],
    ] as const;
    // 第 2 轮：这里配了 CORE_CHAT_TOKEN，/v1 真的走到鉴权（chat/routes.ts callerCtx）。家人的会话令牌（Bearer）和 Cookie 会话
    // 都不是所有者对话令牌、也不是 models:chat 客户端令牌 → 写死 401 UNAUTHORIZED（不再是鉴权之前的 503）
    for (const who of ['xiao', 'xiaoCookie'] as const) {
      for (const [method, url, payload] of V1) {
        const res = await call(who, method, url, payload);
        expect([res.statusCode, errCode(res)], `${who} ${method} ${url}`).toEqual([401, 'UNAUTHORIZED']);
        expect(leakedIn(res)).toEqual([]);
      }
    }
    // 正向对照：所有者对话令牌能进（证明 401 不是因为入口整个关着）
    const ownerChat = await t.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${CHAT_TOKEN}` } });
    expect(ownerChat.statusCode, ownerChat.body.slice(0, 200)).toBe(200);
    for (const w of ['xiao', 'xiaoClient'] as const) {
      const res = await call(w, 'POST', '/internal/route-preview', {});
      expect([res.statusCode, errCode(res)], `${w} /internal/route-preview`).toEqual([403, 'FORBIDDEN']);
    }
    // 设计如此：带 models:chat 的客户端令牌能用 /v1，按令牌主人的成员 / 负责人走（chat/routes.ts callerCtx）。要求：200 且只看得到自己的
    for (const [method, url, payload] of V1) {
      const res = await call('xiaoClient', method, url, payload);
      expect(res.statusCode, `xiaoClient ${method} ${url} → ${res.body.slice(0, 200)}`).toBe(200);
      expect(leakedIn(res), `xiaoClient ${method} ${url}`).toEqual([]);
    }
    // 正向对照：所有者自己的令牌看得到自己的成员（检查器在这个接口上认得出标记）
    expect(leakedIn(await call('ownerClient', 'GET', '/v1/models'))).toContain('owner');
    expect(leakedIn(await call('bClient', 'GET', '/v1/models'))).toEqual(['b']);
  });

  it('重要确认令牌不能跨账号：所有者点完确认拿到的令牌，小号拿去删所有者的或删自己的保险箱条目都不行', async () => {
    // 家人账号自己做不了重要确认（只有普通确认，直接放行），能拿到重要确认令牌的只有所有者
    const own = (await make('xiao', 'POST', '/api/vault', { name: 'xiaoreplay', kind: 'note', value: 'xiao-replay' })).secret.id as string;
    const first = await call('owner', 'DELETE', `/api/vault/${ids.owner.vault}`, {});
    expect(first.statusCode).toBe(428);
    const token = await confirmToken('owner', first);
    // 别人的条目：和不存在的一样 404；自己的条目：令牌绑定的是所有者和那次操作，用在这里要重新确认（428）
    const other = await call('xiao', 'DELETE', `/api/vault/${ids.owner.vault}`, { confirmToken: token });
    expect(other.statusCode, other.body).toBe(404);
    const mine = await call('xiao', 'DELETE', `/api/vault/${own}`, { confirmToken: token });
    // 必改 5：家人删保险箱条目要所有者本人确认，拿所有者的令牌来也一样是 403（不会走到 428 让它自己再确认一次）
    expect([mine.statusCode, errCode(mine)], `小号用所有者的确认令牌删自己的条目 → ${mine.body}`).toEqual([403, 'FORBIDDEN']);
    for (const r of [other, mine]) expect(leakedIn(r)).toEqual([]);
    expect(JSON.stringify((await call('owner', 'GET', '/api/vault')).json())).toContain(ids.owner.vault);
    expect(JSON.stringify((await call('xiao', 'GET', '/api/vault')).json())).toContain(own);
    // 小号也不能替所有者点确认的两步、看确认卡（/api/confirm 只给所有者）
    const ch = first.json().error.confirm as { stepUrl: string };
    expect((await call('xiao', 'POST', ch.stepUrl, { step: 1 })).statusCode).toBe(403);
  });

  it('任务里声明别人的保险箱 id：小号自己的执行员领到任务也取不到别人的凭据；声明了的「别人的」和「不存在的」一样 404', async () => {
    const own = (await make('xiao', 'POST', '/api/vault', { name: 'xiaoexec', kind: 'password', value: `${MARK.xiao}-exec` })).secret.id as string;
    const MISSING_2 = '00000000-0000-4000-8000-0000000000fe';
    // 声明：自己的、所有者的、不存在的（必改 8：不存在的也要声明，才和「别人的」走同一个分支）；B 的不声明
    const tid = (await make('xiao', 'POST', '/api/tasks', { kind: 'login', site: `https://${MARK.xiao}.example.test`, secrets: [own, ids.owner.vault!, MISSING_UUID].map((secretId) => ({ secretId, field: 'value' })) })).task.id as string;
    let claimed: string | undefined;
    for (let n = 0; n < 20 && claimed !== tid; n++) {
      const c = await call('xiaoClient', 'POST', '/api/executor/tasks/claim', { waitSec: 0 });
      expect(leakedIn(c)).toEqual([]);
      claimed = c.body ? (c.json() as Json).task?.id : undefined;
      if (!claimed) break;
    }
    expect(claimed).toBe(tid);
    const get = (secretId: string) => call('xiaoClient', 'POST', `/api/executor/tasks/${tid}/secret`, { secretId, field: 'value' });
    // 正向对照：自己声明的自己的条目取得到（证明这条路真能取出值，404 不是因为别的原因）
    const mine = await get(own);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.body).toContain(`${MARK.xiao}-exec`);
    const result = async (secretId: string) => {
      const r = await get(secretId);
      expect(leakedIn(r), secretId).toEqual([]);
      return [r.statusCode, errCode(r)];
    };
    // 声明过的：别人的 = 保险箱里不存在的，一样 404 SECRET_NOT_FOUND
    expect(await result(ids.owner.vault!), '声明了所有者的条目').toEqual([404, 'SECRET_NOT_FOUND']);
    expect(await result(MISSING_UUID), '声明了不存在的条目').toEqual([404, 'SECRET_NOT_FOUND']);
    // 没声明的：别人的 = 不存在的，一样 422 SECRET_NOT_DECLARED（不先查保险箱，看不出存在）
    expect(await result(ids.b.vault!), '没声明 B 的条目').toEqual([422, 'SECRET_NOT_DECLARED']);
    expect(await result(MISSING_2), '没声明的不存在条目').toEqual([422, 'SECRET_NOT_DECLARED']);
  });

  /**
   * 必改 6：/mcp 逐工具正向对照表（和 /api 的 POSITIVE 同理）：tools/list 里的每个工具都要在这里登记，
   * 由主人（所有者 / B）用自己的客户端令牌、自己的 id 调用，必须成功（不是 isError）；
   * mark = 结果里认得出主人自己的标记（证明「攻击方没看到」不是因为工具本来就什么都不回）。
   */
  interface McpPos {
    args: (v: Victim) => Promise<Json> | Json;
    expect: 'mark' | 'ok' | 'reached';
    /**
     * 带了资源 id：arg = args() 里放 id 的参数，kind = 它在 ids 里的类别（不存在的值取 ids.missing[kind]）。
     * 第 2 轮必改 2：攻击时用 args(受害者) 原样调（别人的 id），再把 arg 换成不存在的值调一次，两次报错必须完全一样
     */
    takesId?: { arg: string; kind: string };
    /** 攻击方调用时的参数（默认 args(受害者)）：会在攻击方名下建东西的工具用攻击方自己的标记，免得自己建的东西里出现受害者标记、被当成泄露 */
    attack?: (v: Victim) => Json;
    why?: string;
  }
  const MCP_DENIED = '工具不存在或当前客户端不可用';
  const MCP_POSITIVE: Record<string, McpPos> = {
    list_tools: { args: () => ({}), expect: 'ok', why: '工具目录，不含个人数据' },
    // shortcut: 测试不联网，call_tool 只证明主人过了 /mcp 的放行检查、真的进了工具网关（127.0.0.1 被网关自己的 SSRF 防护拦下）；要证明完整成功得给 GatewayService 注入 fetch（要改 src），暂不做
    call_tool: { args: () => ({ tool: 'read_webpage', args: { url: 'https://127.0.0.1/' } }), expect: 'reached', why: '不联网，见上' },
    create_task: { args: (v) => ({ kind: 'checkin', site: `https://${MARK[v]}.example.test` }), expect: 'ok', attack: () => ({ kind: 'checkin', site: `https://${MARK.xiao}.example.test` }) },
    get_task: { args: (v) => ({ id: ids[v].task }), expect: 'mark', takesId: { arg: 'id', kind: 'task' } },
    list_tasks: { args: () => ({}), expect: 'mark' },
    cancel_task: { args: async (v) => ({ id: (await make(v, 'POST', '/api/tasks', { kind: 'browse', site: `https://${MARK[v]}.example.test` })).task.id }), expect: 'ok', takesId: { arg: 'id', kind: 'task' } },
    search_library: { args: (v) => ({ query: MARK[v] }), expect: 'mark' },
    get_library_item: { args: (v) => ({ id: ids[v].library }), expect: 'mark', takesId: { arg: 'id', kind: 'library' } },
    submit_resource: { args: (v) => ({ title: `${MARK[v]} mcp`, note: 'x' }), expect: 'ok', attack: () => ({ title: `${MARK.xiao} mcp`, note: 'x' }) },
    list_memory_topics: { args: () => ({}), expect: 'mark' },
    get_memory: { args: (v) => ({ topic: ids[v].memory }), expect: 'mark', takesId: { arg: 'topic', kind: 'memory' } },
  };
  const mcpCall = (who: Who, name: string, args: object) => call(who, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const mcpText = (r: Inject): { isError: boolean; text: string } => {
    const res = (r.json() as Json).result as { isError?: boolean; content?: { text?: string }[] } | undefined;
    return { isError: res?.isError === true, text: (res?.content ?? []).map((c) => c.text ?? '').join('\n') };
  };

  it('/mcp：逐工具正向对照——每个工具由主人用自己的令牌、自己的 id 调用都成功', async () => {
    const listed = ((await call('xiaoClient', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools as { name: string }[]).map((x) => x.name).sort();
    expect(listed, 'tools/list 里的工具要和 MCP_POSITIVE 一一对应（新工具要登记正向对照）').toEqual(Object.keys(MCP_POSITIVE).sort());
    const bad: string[] = [];
    for (const [name, spec] of Object.entries(MCP_POSITIVE)) {
      for (const v of ['owner', 'b'] as const) {
        const r = await mcpCall(clientOf(v), name, await spec.args(v));
        const { isError, text } = mcpText(r);
        const ok = r.statusCode === 200 && (spec.expect === 'reached' ? text !== '' && text !== MCP_DENIED : !isError) && (spec.expect !== 'mark' || leakedIn(r).includes(v));
        if (!ok) bad.push(`${name} [${v}] → ${r.statusCode} ${r.body.slice(0, 200)}`);
      }
    }
    expect(bad, '主人用自己的 id 调自己的 MCP 工具没成功').toEqual([]);
  });

  it('/mcp：小号的全范围客户端令牌，tools/list 里每个工具按 MCP_POSITIVE 的参数换成别人的调一遍；带 id 的工具「别人的 id」和「不存在的 id」报错完全一样', async () => {
    const tools = ((await call('xiaoClient', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools as { name: string }[]).map((x) => x.name);
    // 参数不再按参数名猜（第 2 轮必改 2）：每个工具都从 MCP_POSITIVE 推（正向对照那条已证明表和 tools/list 一一对应）
    expect(tools.filter((n) => !(n in MCP_POSITIVE)), '工具要先在 MCP_POSITIVE 登记').toEqual([]);
    const bad: string[] = [];
    let compared = 0;
    /** 报错的全部可观察内容（JSON-RPC error 或 result 的 isError + 文本）。查询值本身（攻击方自己发的）换成占位，其余逐字比较 */
    const shape = (r: Inject, query: string) => {
      const j = r.json() as Json;
      const scrub = (x: unknown) => (x === undefined ? null : JSON.parse(JSON.stringify(x).split(query).join('<id>')));
      return { status: r.statusCode, error: scrub(j.error), isError: mcpText(r).isError, text: mcpText(r).text.split(query).join('<id>') };
    };
    for (const victim of ['owner', 'b'] as const) {
      for (const name of tools) {
        const spec = MCP_POSITIVE[name]!;
        const args = spec.attack ? spec.attack(victim) : await spec.args(victim);
        const res = await mcpCall('xiaoClient', name, args);
        if (res.statusCode >= 500) bad.push(`${name} [${victim}] → ${res.statusCode}`);
        if (leakedIn(res).length) bad.push(`${name} [${victim}] 泄露：${res.body.slice(0, 200)}`);
        if (!spec.takesId) continue;
        // 带资源 id 的工具：别人的 id 必须报错（正向对照里主人自己调是成功的），且和不存在的 id 报错完全一样
        const { arg, kind } = spec.takesId;
        if (name === 'get_memory') await ATTACK_PREP['DELETE /api/memory/:topic']!(); // 主题名按账号分命名空间：先删掉攻击方自己的同名主题
        const other = String(args[arg]);
        const missing = ids.missing[kind]!;
        expect(other, `${name}：args(${victim}).${arg} 要是受害者的 id`).not.toBe(missing);
        const again = await mcpCall('xiaoClient', name, args);
        const miss = await mcpCall('xiaoClient', name, { ...args, [arg]: missing });
        const a = shape(again, other);
        const m = shape(miss, missing);
        compared++;
        if (!(a.isError || a.error)) bad.push(`${name} [${victim}] 带别人的 id 调用成功了：${again.body.slice(0, 200)}`);
        if (JSON.stringify(a) !== JSON.stringify(m)) bad.push(`${name} [${victim}] 别人的 id 和不存在的 id 报错不一样：${JSON.stringify(a)} ≠ ${JSON.stringify(m)}`);
        if (leakedIn(again).length || leakedIn(miss).length) bad.push(`${name} [${victim}] 泄露`);
      }
    }
    expect(bad).toEqual([]);
    expect(compared, 'get_task、cancel_task、get_library_item、get_memory × owner / B 都要比对').toBe(8);
  });

  it('令牌提权：家人用自己的会话 / arc_ 令牌签发更大范围或所有者级令牌、列出 / 吊销别人的令牌都不行；过期 / 已吊销的令牌不能用', async () => {
    // 1. 会话签发：范围只能从 CLIENT_SCOPES 里挑；所有者级 / 通配 / 能力名一律 400，且没有多出令牌
    const before = ((await make('xiao', 'GET', '/api/clients')).clients as unknown[]).length;
    for (const scopes of [['*'], ['owner'], ['admin'], ['confirm:important'], ['settings:write'], [...CLIENT_SCOPES, 'owner'], [...CLIENT_SCOPES]]) {
      const r = await call('xiao', 'POST', '/api/clients', { name: 'escalate', scopes });
      expect(r.statusCode, `scopes=${scopes.join(',')} → ${r.body}`).toBe(400);
      expect(r.body).not.toMatch(/arc_/);
    }
    for (const extra of [{ userId: 'owner' }, { user_id: ids.b.user }, { role: 'admin' }, { owner: true }]) {
      const r = await call('xiao', 'POST', '/api/clients', { name: 'escalate', scopes: ['library:read'], ...extra });
      expect(r.statusCode, `${JSON.stringify(extra)} → ${r.body}`).toBe(400);
    }
    expect(((await make('xiao', 'GET', '/api/clients')).clients as unknown[]).length).toBe(before);
    // 2. arc_ 令牌不能管理令牌（签发 / 列出 / 吊销 / 全部吊销）
    for (const [m, u, p] of [['POST', '/api/clients', { name: 'x', scopes: [...CLIENT_SCOPES] }], ['GET', '/api/clients', undefined], ['DELETE', `/api/clients/${ids.owner.client}`, undefined], ['DELETE', `/api/clients/${ids.b.client}`, undefined], ['POST', '/api/clients/revoke-all', undefined]] as const) {
      const r = await call('xiaoClient', m, u, p);
      expect(r.statusCode, `${m} ${u} → ${r.body}`).toBe(403);
    }
    // 3. 会话列不到、吊销不了别人的令牌（和不存在的一样 404），全部吊销只吊自己的
    const listed = (await call('xiao', 'GET', '/api/clients')).body;
    expect([ids.owner.client, ids.b.client].filter((x) => listed.includes(x!))).toEqual([]);
    for (const id of [ids.owner.client!, ids.b.client!, MISSING_UUID]) {
      const r = await call('xiao', 'DELETE', `/api/clients/${id}`);
      expect([r.statusCode, errCode(r)], id).toEqual([404, 'NOT_FOUND']);
    }
    const spareX = await make('xiao', 'POST', '/api/clients', { name: 'xiao spare', scopes: ['library:read'] });
    xiaoClientIds.push(spareX.client.id as string);
    const spareH = { authorization: `Bearer ${spareX.token as string}` };
    // 4. 签出来的令牌只在攻击方自己名下：读不到别人的资源库条目，进不了只给所有者的接口
    expect((await t.app.inject({ method: 'GET', url: `/api/library/${ids.owner.library}`, headers: spareH })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/audit', headers: spareH })).statusCode).toBe(403);
    // 5. 已吊销：自己吊销后立刻失效
    expect((await call('xiao', 'DELETE', `/api/clients/${spareX.client.id}`)).statusCode).toBeLessThan(300);
    expect((await t.app.inject({ method: 'GET', url: '/api/clients/self', headers: spareH })).statusCode).toBe(401);
    // 6. 过期：1 天有效期的令牌，时钟拨过去以后不能用（拨回来以免影响别的会话）
    const exp = await make('xiao', 'POST', '/api/clients', { name: 'xiao exp', scopes: ['library:read'], expiresInDays: 1 });
    xiaoClientIds.push(exp.client.id as string);
    const expH = { authorization: `Bearer ${exp.token as string}` };
    expect((await t.app.inject({ method: 'GET', url: '/api/clients/self', headers: expH })).statusCode).toBe(200);
    const now = t.clock.now().toISOString();
    t.clock.advance(2 * 24 * 3600 * 1000);
    const late = await t.app.inject({ method: 'GET', url: '/api/clients/self', headers: expH });
    t.clock.set(now);
    expect(late.statusCode, late.body).toBe(401);
    // 7. 已退出的会话令牌不能再用
    const s = await login('xiaohao@example.test', XIAOHAO_TEST_PASSWORD);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: s })).statusCode).toBeLessThan(300);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s })).statusCode).toBe(401);
    // 别人的令牌照样能用（攻击方的操作没有连带吊销）
    for (const w of ['ownerClient', 'bClient'] as const) expect((await call(w, 'GET', '/api/clients/self')).statusCode, w).toBe(200);
  });

  it('Cookie 会话（SSE）：小号带别人的会话 id 发 /api/chat/stream，和不存在的会话一样 404，流里没有别人的数据', async () => {
    const results: Inject[] = [];
    for (const conv of [ids.owner.conversation!, ids.b.conversation!, MISSING_UUID]) {
      const r = await call('xiaoCookie', 'POST', '/api/chat/stream', { conversationId: conv, messages: [{ role: 'user', content: `${MARK.xiao} hi` }] });
      results.push(r);
      expect(leakedIn(r)).toEqual([]);
    }
    expect(results.map((r) => [r.statusCode, errCode(r)])).toEqual([[404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [404, 'NOT_FOUND']]);
    // 正向对照：B 用自己的 Cookie 会话、自己的会话 id 能拿到流
    const own = await call('bCookie', 'POST', '/api/chat/stream', { conversationId: ids.b.conversation, messages: [{ role: 'user', content: 'hi' }] });
    expect(own.statusCode, own.body.slice(0, 200)).toBe(200);
    expect(own.headers['content-type']).toMatch(/event-stream/);
  });

  it.runIf(env.name !== 'memory')('存储层：应用角色连接（非超级用户、非表所有者），直接 SELECT 读不到别人的行，写不进别人名下（RLS 真的生效）', async () => {
    const db = t.deps.db!;
    const c = await assertAppRoleSafe(db, { expectRole: APP_ROLE });
    expect([c.superuser, c.bypassRls, c.ownedTables, c.notForced]).toEqual([false, false, 0, []]);
    const rlsTables = (await db.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1`,
    )).rows.map((r) => r.t);
    expect(rlsTables).toEqual(expect.arrayContaining(['members', 'vault_secrets', 'library_items', 'public_memory', 'inbox_items', 'provider_keys', 'conversations', 'assistants', 'push_subscriptions', 'work_projects']));
    const victims = ['owner', ids.b.user!];
    const count = async (q: Db, table: string) => Number((await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id::text = ANY($1)`, [victims])).rows[0]!.n);
    let ownerRows = 0;
    const bad: string[] = [];
    // 注入式的身份值（GUC 注入）也只是一个普通字符串：set_config 参数化，读不到任何人的行
    const injected = "x'; SELECT set_config('app.system_scope','on',false); --";
    for (const table of rlsTables) {
      if ((await count(db, table)) !== 0) bad.push(`${table}：不设 app.user_id 直接 SELECT 读到了别人的行`);
      if ((await count(userScoped(db, ids.xiao.user!), table)) !== 0) bad.push(`${table}：以小号身份读到了别人的行`);
      if ((await count(userScoped(db, injected), table)) !== 0) bad.push(`${table}：注入式身份值读到了别人的行`);
      ownerRows += await count(userScoped(db, 'owner'), table);
    }
    expect(bad).toEqual([]);
    // 第 2 轮必改 3：系统范围（只读策略）按 owner / B 数出的行数 = 各自范围数出的行数。系统只读策略漏掉部分行时，
    // 数据库快照（用系统范围读）会少看这些行、越权改了也发现不了；这里逐表、逐账号钉住
    const countOf = async (q: Db, table: string, uid: string) => Number((await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id::text = $1`, [uid])).rows[0]!.n);
    const sysAll = systemScoped(db);
    const scopeGaps: string[] = [];
    for (const table of rlsTables) {
      for (const uid of victims) {
        const [inSys, inOwn] = [await countOf(sysAll, table, uid), await countOf(userScoped(db, uid), table, uid)];
        if (inSys !== inOwn) scopeGaps.push(`${table} [${uid === 'owner' ? 'owner' : 'b'}]：系统范围 ${inSys} 行，本人范围 ${inOwn} 行`);
      }
    }
    expect(scopeGaps, '系统只读策略和本人范围看到的行数不一致（快照会漏看）').toEqual([]);
    // 正向对照：所有者自己的范围里确实有行（不是因为表是空的才读不到）
    expect(ownerRows).toBeGreaterThan(10);
    expect(await count(userScoped(db, 'owner'), 'vault_secrets')).toBeGreaterThan(0);
    // 必改 7：没开 RLS 的表必须正好等于这份白名单（新增没开 RLS 的表 → 失败，要么开 RLS，要么在这里写理由）
    const allTables = (await db.query<{ t: string }>(`SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' ORDER BY 1`)).rows.map((r) => r.t);
    expect(allTables.filter((x) => !rlsTables.includes(x)).sort(), '没开 RLS 的表和 NO_RLS_TABLES 白名单不一致').toEqual(Object.keys(NO_RLS_TABLES).sort());
    // 必改 7：写操作逐表测。每张 RLS 表：小号身份 UPDATE / DELETE 别人的行影响 0 行；往 owner / B 名下 INSERT 被 RLS（WITH CHECK）拒。
    // 每条都在事务里做完就回滚：万一 RLS 失效也不会真把数据删掉、影响后面的用例
    const ROLLBACK = new Error('rollback');
    const inTx = async <T,>(q: Db, fn: (x: Queryable) => Promise<T>): Promise<T> => {
      let out: T | undefined;
      await q.tx(async (x) => { out = await fn(x); throw ROLLBACK; }).catch((e) => { if (e !== ROLLBACK) throw e; });
      return out as T;
    };
    const xiao = userScoped(db, ids.xiao.user!);
    const sys = systemScoped(db);
    const writeBad: string[] = [];
    for (const table of rlsTables) {
      const cols = (await db.query<{ c: string }>(
        `SELECT a.attname AS c FROM pg_attribute a WHERE a.attrelid = (current_schema() || '.' || $1)::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' AND a.attidentity <> 'a' ORDER BY a.attnum`, [table],
      )).rows.map((r) => r.c);
      // 正向对照：主人自己的范围里，同一个 WHERE 确实选得到行（不是因为表里没数据 / WHERE 写错才 0 行）
      const own = (await count(userScoped(db, 'owner'), table)) + (await count(userScoped(db, ids.b.user!), table));
      if (own === 0) writeBad.push(`${table}：正向对照失败，owner / B 自己的范围里一行都没有（写测试没测到）`);
      // 小号身份：影响 0 行。「permission denied for table」= 应用角色压根没有这种写权限（只追加的表不给 DELETE），比 RLS 更早拦下，算过；
      // 别的报错算失败——RLS 生效时别人的行根本不可见，行级触发器（如 conversation_messages 只追加）不会被触发
      const hits = async (sql: string): Promise<string | null> => {
        try {
          const n = (await inTx(xiao, (x) => x.query(sql, [victims]))).rows.length;
          return n ? `影响了 ${n} 行` : null;
        } catch (e) {
          const m = (e as Error).message;
          return /permission denied for table/i.test(m) ? null : `报错（说明看得见别人的行）：${m.slice(0, 100)}`;
        }
      };
      for (const [what, sql] of [
        ['UPDATE 别人的行', `UPDATE ${table} SET user_id = user_id WHERE user_id::text = ANY($1) RETURNING 1`],
        ['把别人的行改到自己名下', `UPDATE ${table} SET user_id = '${ids.xiao.user!}' WHERE user_id::text = ANY($1) RETURNING 1`],
        ['DELETE 别人的行', `DELETE FROM ${table} WHERE user_id::text = ANY($1) RETURNING 1`],
      ] as const) {
        const h = await hits(sql);
        if (h) writeBad.push(`${table}：小号 ${what} ${h}`);
      }
      // INSERT：拿一行受害者的真实数据当模板（系统范围只读），换掉 id，以小号身份插到 owner / B 名下
      const tpl = (await sys.query<{ j: Record<string, unknown> }>(`SELECT to_jsonb(x) AS j FROM ${table} x WHERE user_id::text = ANY($1) LIMIT 1`, [victims])).rows[0]?.j;
      if (!tpl) continue; // 上面的正向对照已经报了
      const j = typeof tpl === 'string' ? (JSON.parse(tpl) as Record<string, unknown>) : tpl;
      // user_sessions.user_id 是 uuid（外键 users.id），'owner' 不是合法值，往 owner 名下插是类型错误而不是 RLS 拒绝；它的 WITH CHECK 用 B 的 id 测
      const uidType = (await db.query<{ t: string }>(`SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = (current_schema() || '.' || $1)::regclass AND a.attname = 'user_id'`, [table])).rows[0]?.t;
      for (const target of victims) {
        if (uidType === 'uuid' && target === 'owner') continue;
        const row = { ...j, user_id: target, ...(typeof j.id === 'string' ? { id: /^[0-9a-f-]{36}$/.test(j.id) ? randomUUID() : `${j.id}x176` } : {}) };
        const list = cols.join(', ');
        const err = await inTx(xiao, (x) => x.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)])).then(() => null, (e: Error) => e);
        if (!err) writeBad.push(`${table}：小号往 ${target} 名下 INSERT 成功了`);
        else if (!/row-level security/i.test(err.message)) writeBad.push(`${table}：往 ${target} 名下 INSERT 失败，但不是被 RLS 拒的（${err.message.slice(0, 120)}）——没测到 WITH CHECK`);
      }
    }
    expect(writeBad, 'RLS 写操作逐表').toEqual([]);
    await expect(xiao.query(`INSERT INTO library_items (id, user_id, kind, title, body, created_at, updated_at) VALUES ($1, 'owner', 'idea', 'x', 'x', now(), now())`, [randomUUID()])).rejects.toThrow(/row-level security/i);
    expect(await count(userScoped(db, 'owner'), 'vault_secrets')).toBeGreaterThan(0);
  });

  it('遍历全部路由（改参 + 重放 + query / body / 头里的别人的 id）：严格按声明的状态码，看不出存在，不泄露，数据库里受害者的行一行不变', async () => {
    await t.app.assistants.runner.idle();
    const snap0 = await dbSnapshot();
    if (snap0) expect(sideGaps(snap0), '数据库快照逐表正向对照（必改 2）').toEqual([]);
    const before = snap0?.rows ?? (await apiSnapshot());
    // 快照本身要真的含有受害者的数据，否则「没变」说明不了什么
    const flat = Object.values(before).flat().join('\n');
    expect(flat).toContain(MARK.owner);
    expect(flat).toContain(MARK.b);
    expect(flat).toContain(ids.b.user);

    const routes = apiRoutes().filter((r) => !SELF_ENDING.includes(key(r)));
    const wrong: string[] = [];
    const leaks: string[] = [];
    const oracle: string[] = [];
    const listLeak: string[] = [];
    const check = (label: string, res: Inject, exp: Exp) => {
      if (!statusOk(exp, res.statusCode) || (exp.code !== undefined && errCode(res) !== exp.code)) wrong.push(`${label} → ${res.statusCode} ${errCode(res)}，应为 ${exp.status} ${exp.code ?? ''} ${res.body.slice(0, 120)}`);
      const l = leakedIn(res);
      if (l.length) leaks.push(`${label} 泄露 ${l.join(',')}：${res.body.slice(0, 200)}`);
    };
    const expFor = (r: SeenRoute, attacker: Attacker): Exp =>
      attacker === 'xiaoClient' ? (clientCanEnter(r) ? CLIENT[key(r)]! : FORBID) : isOwnerOnly(r) ? FORBID : FAMILY[key(r)]!;
    const forgedCursor = (v: Victim | 'missing') => Buffer.from(`2099-01-01T00:00:00.000Z|${ids[v].conversation}`).toString('base64url');
    let injCompared = 0;
    const run = async (r: SeenRoute, victim: Victim, attacker: Attacker) => {
      const exp = expFor(r, attacker);
      const label = `${key(r)} [${attacker}→${victim}]`;
      const n = nonce();
      // 第 2 轮必改 1 每条注入多一个「不存在的 id」对照，攻击方会话一分钟内会超过按凭据的限速（1200）、拿到 429。
      // 换一个新登录的会话（同一个小号账号，限速按凭据算）；客户端令牌那轮请求少，不用换
      if (attacker === 'xiao' && (sent.xiao ?? 0) > 900) {
        headers.xiao = await login('xiaohao@example.test', XIAOHAO_TEST_PASSWORD);
        sent.xiao = 0;
      }
      await ATTACK_PREP[key(r)]?.();
      const res = await attack(r, victim, attacker, n);
      check(label, res, exp);
      // 必改 3：带别人的 id 和带不存在的 id，结果完全一样（家人能用的带 id 路由必须是 404，不是 403）
      const body = (v: Victim | 'missing') => JSON.stringify(r.method === 'GET' ? null : BODIES[key(r)]?.('xiao', ids[v], n));
      if (r.url.includes(':') || body(victim) !== body('missing')) {
        await ATTACK_PREP[key(r)]?.();
        const miss = await attack(r, 'missing', attacker);
        if (res.statusCode !== miss.statusCode || errCode(res) !== errCode(miss)) oracle.push(`${label} 别人的 id → ${res.statusCode} ${errCode(res)}，不存在的 id → ${miss.statusCode} ${errCode(miss)}`);
      }
      if (exp.list && res.statusCode === 200) {
        const hit = victimIds(victim, exp.echoes).filter(([, x]) => res.body.includes(x)).map(([k, x]) => `${k}=${x}`);
        if (hit.length) listLeak.push(`${label} 列表里有受害者的 id ${hit.join(',')}`);
      }
      // 路径之外的别人的 id（必改 1）：身份覆盖头、query（含 ids 数组、伪造的翻页游标、排序 / 过滤）、请求体嵌套字段，
      // 三种分成三个独立请求（塞一起时 body 被 schema 拒成 400，头和 query 就没测到）。
      // 期望：头注入不碰 schema，必须和声明的完全一样；只给所有者的（期望 403）三种都必须严格 == 403，不接受 400；
      // 家人能用的 query / body 注入，允许声明的期望或「schema 校验拒绝」（isSchema400：BAD_REQUEST + fields，只有 http/errors.ts 的校验分支这样回）。
      // 第 2 轮必改 1：处理器自己回的业务 400 不算 schema 拒绝 → 失败；凡是放过 400 的注入，再拿不存在的 id 做同样的注入，
      // 状态码和错误码必须完全一样（否则业务 400 / 404 的差异就是一条存在性旁路）。不泄露；数据库快照兜底「没写到别人名下」
      const injectionsFor = (target: Victim | 'missing'): [string, NonNullable<Parameters<typeof attack>[4]>][] => {
        const v = ids[target];
        const uid = target === 'owner' ? 'owner' : v.user!;
        return [
          ['头', { headers: { 'x-user-id': uid, 'x-aroomo-user-id': uid, 'x-forwarded-user': uid, 'x-aroomo-scope': 'owner' } }],
          ['query', {
            query: new URLSearchParams([
              ['userId', uid], ['user_id', uid], ['scope', 'owner'], ['memberId', v.member!], ['vaultId', v.vault!], ['parentId', v.library!],
              ['ids', v.inbox!], ['ids[]', v.library!], ['cursor', forgedCursor(target)], ['sort', 'user_id'], ['filter', 'all'], ['deleted', 'true'],
            ]).toString(),
          }],
          // GET 不收请求体，不发
          ...(r.method === 'GET' ? [] : [['body', { body: { userId: uid, user_id: uid, scope: 'owner', memberId: v.member, vaultId: v.vault, parentId: v.library, ids: [v.inbox, v.library, v.task] } }] as [string, NonNullable<Parameters<typeof attack>[4]>]]),
        ];
      };
      // 「只给所有者」按路由声明认（不是按期望 403 认：家人登记 HTTP 工具的 403 是处理器里的业务规则，schema 先跑是对的）
      const ownerOnly = attacker === 'xiaoClient' ? !clientCanEnter(r) : isOwnerOnly(r);
      const missingInj = injectionsFor('missing');
      for (const [idx, [kind, extra]] of injectionsFor(victim).entries()) {
        await ATTACK_PREP[key(r)]?.();
        const inj = await attack(r, victim, attacker, nonce(), extra);
        const allow400 = !ownerOnly && kind !== '头';
        const declared = statusOk(exp, inj.statusCode) && (exp.code === undefined || errCode(inj) === exp.code);
        if (!declared && !(allow400 && isSchema400(inj))) {
          const why = inj.statusCode === 400 && allow400 ? '（400 但不是 schema 校验拒的——处理器的业务 400，存在性旁路）' : '';
          wrong.push(`${label} ${kind}注入别人的 id → ${inj.statusCode} ${errCode(inj)}${why}，应为 ${exp.status} ${exp.code ?? ''}${allow400 ? '（或 schema 400）' : ''} ${inj.body.slice(0, 120)}`);
        }
        if (leakedIn(inj).length) leaks.push(`${label} ${kind}注入别人的 id 后泄露：${inj.body.slice(0, 200)}`);
        if (allow400) {
          injCompared++;
          await ATTACK_PREP[key(r)]?.();
          const miss = await attack(r, 'missing', attacker, nonce(), missingInj[idx]![1]);
          if (inj.statusCode !== miss.statusCode || errCode(inj) !== errCode(miss)) {
            oracle.push(`${label} ${kind}注入：别人的 id → ${inj.statusCode} ${errCode(inj)}，不存在的 id → ${miss.statusCode} ${errCode(miss)}`);
          }
        }
      }
    };
    // 先用小号自己发的全范围客户端令牌打一遍，再用小号会话打一遍
    for (const victim of ['owner', 'b'] as const) for (const r of routes) await run(r, victim, 'xiaoClient');
    for (const victim of ['owner', 'b'] as const) for (const r of routes) await run(r, victim, 'xiao');
    // 翻页游标指向别人的会话：只回自己的（受害者的会话一个都没有）
    for (const victim of ['owner', 'b'] as const) {
      const r = await call('xiao', 'GET', `/api/conversations?cursor=${forgedCursor(victim)}`);
      check(`GET /api/conversations?cursor=<${victim} 的会话>`, r, { status: 200 });
      if (r.body.includes(ids[victim].conversation!)) listLeak.push(`伪造游标拿到了 ${victim} 的会话`);
    }
    // 会结束攻击方自己会话 / 令牌的放最后（logout-all、revoke-all 不能顺带踢掉别人）
    // 每条之前小号重新登录一次（上一条已经结束了它的会话），令牌先打（会话那轮的 revoke-all 会吊销它）
    for (const attacker of ['xiaoClient', 'xiao'] as const) for (const k of SELF_ENDING) {
      const r = apiRoutes().find((x) => key(x) === k)!;
      if (attacker === 'xiao') headers.xiao = await login('xiaohao@example.test', XIAOHAO_TEST_PASSWORD);
      const res = await attack(r, 'b', attacker);
      check(`${k} [${attacker}]`, res, expFor(r, attacker));
    }
    await t.app.assistants.runner.idle();

    expect(wrong, '状态码和声明的期望不一致（只给所有者的必须 403；家人能用的按 FAMILY / CLIENT）').toEqual([]);
    expect(leaks, '响应（正文 / 响应头 / SSE / 编码后）里出现了别人的数据').toEqual([]);
    expect(oracle, '能从响应差异看出别人的资源存在').toEqual([]);
    expect(listLeak, '列表接口里出现了别人的资源').toEqual([]);
    // 「别人的 = 不存在的」注入对照真的跑了（家人能用的 query / body 注入每条都比对；0 = 循环没走到）
    expect(injCompared, '放过 schema 400 的注入都要拿不存在的 id 再打一遍').toBeGreaterThan(50);

    const after = await snapshot();
    const changed = diff(before, after);
    // 消息里带上变了的表名（自证脚本按它判断是不是快照抓到的）
    expect(changed, `受害者的数据被家人账号改动了（数据库快照，按 owner / B）：${changed.map((x) => x.split('\n')[0]).join(', ')}`).toEqual([]);
    // 别人的会话 / 令牌没被攻击方的 logout-all / revoke-all 连带踢掉
    for (const w of ['owner', 'b', 'ownerClient', 'bClient'] as const) expect((await call(w, 'GET', w.endsWith('Client') ? '/api/clients/self' : '/api/auth/me')).statusCode, w).toBe(200);
    // 三种注入分开发（必改 1）以后 PGlite 上约 20 秒，默认 30 秒太贴边（机器忙时会超时）
  }, 120_000);
});
