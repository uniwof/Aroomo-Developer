/**
 * D208 越权测试：
 *  1. 每条 /api 路由必须声明权限（capability / clientScope / clientSelf 之一），新路由漏声明 → 本测试失败。
 *  2. 小号（普通账号）请求任何没声明 userRoute 的 /api 路由，必须 401/403，绝不能 2xx 或 5xx。
 *  3. 没带令牌请求所有 /api 路由，必须 401（或 503 未配置）。
 * 如何声明权限见 docs/authz-testing.md。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryDeps } from '../../src/deps.js';
import { twoAccounts, type TwoAccounts } from '../helpers/two-accounts.js';
import { OWNER_ONLY_BASELINE } from './owner-only-baseline.js';
import { concretize, seenRoutes } from './route-registry.js';

vi.mock('fastify', async (orig) => (await import('./route-registry.js')).wrapFastify(await orig<typeof import('fastify')>()));

let t: TwoAccounts;
beforeAll(async () => {
  t = await twoAccounts({ name: 'memory', make: async (now) => memoryDeps(now) });
});
afterAll(async () => {
  await t.close();
});

/** 有意不要求声明权限的路由（登录前就要能访问）；新增要在这里写理由 */
const PUBLIC_API: string[] = [];

const apiRoutes = () => seenRoutes.filter((r) => r.url.startsWith('/api/') && !PUBLIC_API.includes(`${r.method} ${r.url}`));

describe('D208 权限声明', () => {
  it('收集到了路由', () => {
    expect(apiRoutes().length).toBeGreaterThan(10);
  });

  it('每条 /api 路由都声明了权限', () => {
    const missing = apiRoutes()
      .filter((r) => r.config.capability === undefined && r.config.clientScope === undefined && r.config.clientSelf !== true)
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => !OWNER_ONLY_BASELINE.includes(k));
    expect(missing, `这些路由没声明权限（见 docs/authz-testing.md）：\n${missing.join('\n')}`).toEqual([]);
  });

  it('无令牌访问所有 /api 路由都被拒绝', async () => {
    const bad: string[] = [];
    for (const r of apiRoutes()) {
      const res = await t.app.inject({ method: r.method as 'GET', url: concretize(r.url) });
      if (res.statusCode !== 401 && res.statusCode !== 503) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('小号访问非 userRoute 的路由一律 403', async () => {
    const bad: string[] = [];
    for (const r of apiRoutes().filter((x) => x.config.userRoute !== true)) {
      const res = await t.xiao(r.method as 'GET', concretize(r.url), r.method === 'GET' ? undefined : {});
      if (res.statusCode !== 403 && res.statusCode !== 401) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('小号访问 userRoute 路由不会 5xx', async () => {
    const bad: string[] = [];
    for (const r of apiRoutes().filter((x) => x.config.userRoute === true)) {
      const res = await t.xiao(r.method as 'GET', concretize(r.url), r.method === 'GET' ? undefined : {});
      if (res.statusCode >= 500) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
});
