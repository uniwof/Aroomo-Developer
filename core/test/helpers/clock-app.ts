/**
 * 假时钟测试（工单 #230）的公共夹具：和 twoAccounts 一样造「所有者 + 小号」，
 * 但允许在建服务之前改 deps（例如换假的上游聊天），并把小号登录的时间放在假时钟的起点。
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { type CoreDeps } from '../../src/deps.js';
import { buildServer } from '../../src/server.js';
import { seedXiaohao } from '../../src/users/seed.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './db.js';
import { type Caller, type DepsEnv, XIAOHAO_TEST_EMAIL, XIAOHAO_TEST_PASSWORD } from './two-accounts.js';

export interface ClockApp {
  app: FastifyInstance;
  deps: CoreDeps;
  clock: ReturnType<typeof fakeClock>;
  owner: Caller;
  xiao: Caller;
  xiaoId: string;
  xiaoHeaders: Record<string, string>;
  /** 用任意 Bearer 令牌发请求 */
  bearer: (token: string) => Caller;
  /** 用小号密码重新登录，返回新的会话令牌 */
  loginXiao: () => Promise<string>;
}

export async function clockApp(
  env: DepsEnv,
  opts: { start?: string; config?: Record<string, string>; prepare?: (deps: CoreDeps) => void } = {},
): Promise<ClockApp> {
  const clock = fakeClock();
  if (opts.start) clock.set(opts.start);
  const deps = await env.make(clock.now);
  opts.prepare?.(deps);
  const app = buildServer(
    loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', CORE_JOBS: 'off', ...(opts.config ?? {}) }),
    deps,
  );
  const { userId } = await seedXiaohao(deps.users, { email: XIAOHAO_TEST_EMAIL, password: XIAOHAO_TEST_PASSWORD }, clock.now);
  const caller =
    (headers: Record<string, string>): Caller =>
    (method, url, payload, extra) =>
      app.inject({ method, url, headers: { ...headers, ...(extra ?? {}) }, ...(payload ? { payload } : {}) } as InjectOptions);
  const loginXiao = async (): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: XIAOHAO_TEST_EMAIL, password: XIAOHAO_TEST_PASSWORD } });
    if (r.statusCode !== 200) throw new Error(`小号登录失败 ${r.statusCode}`);
    return r.json().token as string;
  };
  const xiaoHeaders = { authorization: `Bearer ${await loginXiao()}` };
  return {
    app,
    deps,
    clock,
    owner: caller(ownerAuth),
    xiao: caller(xiaoHeaders),
    xiaoId: userId,
    xiaoHeaders,
    bearer: (token) => caller({ authorization: `Bearer ${token}` }),
    loginXiao,
  };
}
