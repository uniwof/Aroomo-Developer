/**
 * 工具网关接口（M2）。只有本人（所有者令牌或账号会话）可用；操作员和客户端令牌一律 403
 * （外部 MCP 客户端经 /mcp 暴露网关是下一步，且只给 read 级工具）。
 * spend / danger 的调用第一次返回 428 + 确认卡，带 confirmToken 重发才执行（同保险箱）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { confirmCtx, scopeOf } from '../auth/plugin.js';
import type { HttpToolDef } from '../adapters/http-tool.js';
import { HttpError } from '../http/errors.js';
import type { GatewayService } from './service.js';

export function registerGatewayRoutes(app: FastifyInstance, svc: GatewayService): void {
  const cfg = {
    config: { userRoute: true as const },
    preHandler: async (req: FastifyRequest) => {
      const p = req.principal;
      if (!p || (p.type !== 'owner' && p.type !== 'user')) throw new HttpError(403, 'FORBIDDEN', '只有本人登录后可以使用工具网关');
    },
  };
  const confirmToken = { type: 'string', minLength: 1, maxLength: 128 } as const;

  app.get('/api/gateway/tools', { ...cfg }, async (req) => ({ tools: await svc.list(scopeOf(req)) }));

  app.post<{ Body: { tool: string; args?: Record<string, unknown>; confirmToken?: string } }>(
    '/api/gateway/call',
    {
      ...cfg,
      schema: {
        body: {
          type: 'object',
          required: ['tool'],
          additionalProperties: false,
          properties: { tool: { type: 'string', maxLength: 64 }, args: { type: 'object' }, confirmToken },
        },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const r = await svc.call(scopeOf(req), req.body.tool, req.body.args ?? {}, confirmCtx(req.principal!, req.body.confirmToken), req.audit);
      return r;
    },
  );

  app.get('/api/gateway/http-tools', { ...cfg }, async (req) => ({ tools: await svc.listHttpTools(scopeOf(req)) }));

  app.put<{ Body: { def: Record<string, unknown>; confirmToken?: string } }>(
    '/api/gateway/http-tools',
    {
      ...cfg,
      schema: { body: { type: 'object', required: ['def'], additionalProperties: false, properties: { def: { type: 'object' }, confirmToken } } },
    },
    async (req) => {
      const d = req.body.def as Record<string, unknown> & { auth?: unknown; perDayLimit?: unknown; risk?: unknown };
      const def = {
        toolId: String(d.toolId ?? ''),
        name: String(d.name ?? d.toolId ?? ''),
        ...(typeof d.description === 'string' ? { description: d.description } : {}),
        baseUrl: String(d.baseUrl ?? ''),
        auth: (d.auth && typeof d.auth === 'object' ? d.auth : { type: 'none' }) as HttpToolDef['auth'],
        allowedHosts: Array.isArray(d.allowedHosts) ? d.allowedHosts.map(String) : [],
        risk: (['read', 'write', 'spend', 'danger'] as const).find((r) => r === d.risk) ?? 'danger',
        perDayLimit: typeof d.perDayLimit === 'number' && Number.isInteger(d.perDayLimit) && d.perDayLimit > 0 ? Math.min(d.perDayLimit, 10_000) : 100,
        enabled: d.enabled !== false,
      };
      return { tool: await svc.putHttpTool(scopeOf(req), def, confirmCtx(req.principal!, req.body.confirmToken), req.audit) };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/gateway/http-tools/:id', { ...cfg, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 41 } } } } }, async (req, reply) => {
    await svc.deleteHttpTool(scopeOf(req), req.params.id, req.audit);
    return reply.status(204).send();
  });
}
