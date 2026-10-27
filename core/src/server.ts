import Fastify, { type FastifyInstance } from 'fastify';
import { type ActorType, type AuditLog, getGlobalAuditLog } from './audit/index.js';
import type { CoreConfig } from './config.js';
import { route } from './router/route.js';
import type { RoutableMember } from './router/types.js';

export const VERSION = '0.0.1';

interface RoutePreviewBody {
  text: string;
  members: RoutableMember[];
  leadId?: string | null;
}

export function buildServer(cfg: CoreConfig, auditLog: AuditLog = getGlobalAuditLog()): FastifyInstance {
  const app = Fastify({
    logger:
      cfg.logLevel === 'silent'
        ? false
        : {
            level: cfg.logLevel,
            // 防止密钥进日志（PRODUCT 0.4）
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
          },
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'aroomo-core', version: VERSION }));

  /**
   * 只读审计日志 API（分页查询）
   * GET /api/audit
   */
  app.get<{
    Querystring: {
      actorType?: ActorType;
      actorId?: string;
      actor?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      target?: string;
      from?: string;
      to?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/api/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            actorType: { type: 'string', enum: ['owner', 'operator', 'system', 'member'] },
            actorId: { type: 'string', maxLength: 128 },
            actor: { type: 'string', maxLength: 128 },
            action: { type: 'string', maxLength: 128 },
            targetType: { type: 'string', maxLength: 128 },
            targetId: { type: 'string', maxLength: 128 },
            target: { type: 'string', maxLength: 128 },
            from: { type: 'string' },
            to: { type: 'string' },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query;

      let actorParam: { type?: ActorType; id?: string } | string | undefined;
      if (q.actorType || q.actorId) {
        actorParam = {
          type: q.actorType,
          id: q.actorId,
        };
      } else if (q.actor) {
        actorParam = q.actor;
      }

      let targetParam: { type?: string; id?: string } | string | undefined;
      if (q.targetType || q.targetId) {
        targetParam = {
          type: q.targetType,
          id: q.targetId,
        };
      } else if (q.target) {
        targetParam = q.target;
      }

      const fromNum = q.from ? parseInt(q.from, 10) : undefined;
      const toNum = q.to ? parseInt(q.to, 10) : undefined;
      const limitNum = q.limit ? parseInt(q.limit, 10) : undefined;

      const result = await auditLog.query({
        actor: actorParam,
        action: q.action,
        target: targetParam,
        from: Number.isNaN(fromNum) ? undefined : fromNum,
        to: Number.isNaN(toNum) ? undefined : toNum,
        limit: Number.isNaN(limitNum) ? undefined : limitNum,
        cursor: q.cursor,
      });

      return reply.send(result);
    },
  );

  /**
   * 路由预览（内部接口，P0 骨架）：给定输入和成员列表，返回路由计划，不调用任何模型。
   * 只在容器网络内可达；对外入口由后续 Issue 加鉴权后再开放。
   */
  app.post<{ Body: RoutePreviewBody }>(
    '/internal/route-preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text', 'members'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', maxLength: 20000 },
            leadId: { type: ['string', 'null'] },
            members: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['id', 'name', 'enabled'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 128 },
                  name: { type: 'string', minLength: 1, maxLength: 128 },
                  aliases: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (req) => route(req.body.text, { members: req.body.members, leadId: req.body.leadId ?? null }),
  );

  return app;
}
