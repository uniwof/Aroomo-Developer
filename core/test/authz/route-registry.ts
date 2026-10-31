/**
 * D208 越权测试框架：收集 buildServer 注册的全部路由（含声明的权限配置）。
 * 做法：在 fastify 构造后立刻挂 onRoute 钩子，之后注册的每条路由都会被记录。
 */
export interface SeenRoute {
  method: string;
  url: string;
  config: Record<string, unknown>;
}

export const seenRoutes: SeenRoute[] = [];

/** 在测试文件里写：vi.mock('fastify', async (orig) => (await import('./route-registry.js')).wrapFastify(await orig())) */
export function wrapFastify<T extends { default: (...a: never[]) => unknown }>(real: T): T {
  const wrapped = ((...args: never[]) => {
    const app = real.default(...args) as { addHook: (n: string, f: (r: { method: string | string[]; url: string; config?: object }) => void) => void };
    app.addHook('onRoute', (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        seenRoutes.push({ method: m, url: r.url, config: { ...(r.config ?? {}) } });
      }
    });
    return app;
  }) as unknown as T['default'];
  return { ...real, default: wrapped };
}

/** 把 /api/members/:id 换成能直接请求的假路径 */
export const concretize = (url: string): string => url.replace(/:[A-Za-z_]+/g, 'x-missing-id').replace(/\*/g, 'x');
