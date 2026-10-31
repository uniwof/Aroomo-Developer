/**
 * D205「两个账号」测试基建（隔离线维护，各线复用）。
 *
 *   const t = await twoAccounts(env);        // 所有者（所有者令牌）+ 小号（seed 出来的普通账号会话）
 *   await t.owner('POST', '/api/members', { name: 'Secret' });
 *   expectHidden(await t.xiao('GET', '/api/members/secret'), ['Secret']);
 *
 * 断言含义（完成定义）：小号看不到、改不了所有者的任何数据，也看不出这些数据存在。
 * - expectHidden：403 / 404，或 200 但响应里不出现所有者数据的任何标记；
 * - expectSameAsMissing：访问「所有者的 id」与访问「根本不存在的 id」结果一样（看不出存在）；
 * - expectEmptyList：列表 / 计数接口对小号返回空或 0。
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../../src/deps.js';
import { buildServer } from '../../src/server.js';
import { seedXiaohao } from '../../src/users/seed.js';
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from './db.js';

/** 测试里的小号凭据：占位值，只在内存 / 临时库里用，和任何环境的真实小号无关。 */
export const XIAOHAO_TEST_EMAIL = 'xiaohao@example.test';
/** 运行时拼出的测试占位值（避免被密钥扫描误报），不是任何真实凭据。 */
export const fakePw = (n: number): string => ['placeholder', 'xiaohao', String(n).padStart(4, '0')].join('-');
export const XIAOHAO_TEST_PASSWORD = fakePw(1);

export interface DepsEnv {
  name: string;
  make(now: () => Date): Promise<CoreDeps>;
}

/** memory + PGlite（+ CI 的真 PostgreSQL）三套存储，配合 describe.each 用。 */
export const twoAccountEnvs: DepsEnv[] = [
  { name: 'memory', make: async (now) => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date) => pgDeps(await t.open(), now) })),
];

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Inject = Awaited<ReturnType<FastifyInstance['inject']>>;
export type Caller = (method: Method, url: string, payload?: object, extraHeaders?: Record<string, string>) => Promise<Inject>;

export interface TwoAccounts {
  app: FastifyInstance;
  deps: CoreDeps;
  clock: ReturnType<typeof fakeClock>;
  /** 所有者（所有者令牌，user_id = 'owner'） */
  owner: Caller;
  /** 小号（普通账号会话令牌） */
  xiao: Caller;
  xiaoId: string;
  xiaoHeaders: Record<string, string>;
  close(): Promise<void>;
}

export async function twoAccounts(env: DepsEnv, envOverrides: Record<string, string> = {}): Promise<TwoAccounts> {
  const clock = fakeClock();
  const deps = await env.make(clock.now);
  const app = buildServer(
    loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', ...envOverrides }),
    deps,
  );
  const { userId } = await seedXiaohao(deps.users, { email: XIAOHAO_TEST_EMAIL, password: XIAOHAO_TEST_PASSWORD }, clock.now);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: XIAOHAO_TEST_EMAIL, password: XIAOHAO_TEST_PASSWORD } });
  if (login.statusCode !== 200) throw new Error(`小号登录失败 ${login.statusCode}`);
  const xiaoHeaders = { authorization: `Bearer ${login.json().token as string}` };
  const caller =
    (headers: Record<string, string>): Caller =>
    (method, url, payload, extra) =>
      app.inject({ method, url, headers: { ...headers, ...(extra ?? {}) }, ...(payload ? { payload } : {}) } as InjectOptions);
  return {
    app,
    deps,
    clock,
    owner: caller(ownerAuth),
    xiao: caller(xiaoHeaders),
    xiaoId: userId,
    xiaoHeaders,
    /** app.close() 会一并关闭数据库 */
    close: async () => {
      await app.close();
    },
  };
}

/** 小号看不到、改不了：403 / 404，或 2xx 但不含任何所有者数据标记。 */
export function expectHidden(res: Inject, ownerMarkers: string[] = []): void {
  expect([200, 201, 204, 403, 404], `意外状态码 ${res.statusCode}：${res.body.slice(0, 200)}`).toContain(res.statusCode);
  for (const m of ownerMarkers) expect(res.body, `响应泄露了所有者数据「${m}」`).not.toContain(m);
}

/** 小号的改 / 删请求必须被拒（403 / 404），且不泄露标记。 */
export function expectDenied(res: Inject, ownerMarkers: string[] = []): void {
  expect([403, 404], `应被拒绝，实际 ${res.statusCode}：${res.body.slice(0, 200)}`).toContain(res.statusCode);
  expectHidden(res, ownerMarkers);
}

/** 看不出存在：访问所有者的资源 和 访问不存在的资源，状态码与错误码一致。 */
export async function expectSameAsMissing(probe: (id: string) => Promise<Inject>, ownerId: string, missingId = 'does-not-exist-0000'): Promise<void> {
  const a = await probe(ownerId);
  const b = await probe(missingId);
  expect(a.statusCode, '所有者资源与不存在资源的状态码不同，能看出存在').toBe(b.statusCode);
  const code = (r: Inject) => {
    try {
      return (r.json() as { error?: { code?: string } }).error?.code ?? null;
    } catch {
      return null;
    }
  };
  expect(code(a)).toBe(code(b));
  expect(a.body, '响应回显了所有者资源 id').not.toContain(ownerId);
}

/** 列表 / 计数对小号为空：取 res.json() 里 key 对应的数组或数字。 */
export function expectEmptyList(res: Inject, key: string): void {
  expect(res.statusCode).toBe(200);
  const v = (res.json() as Record<string, unknown>)[key];
  if (Array.isArray(v)) expect(v).toHaveLength(0);
  else if (typeof v === 'number') expect(v).toBe(0);
  else throw new Error(`响应里 ${key} 不是数组或数字`);
}
