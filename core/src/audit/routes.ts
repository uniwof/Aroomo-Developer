import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import { badRequest } from '../http/errors.js';
import { InvalidCursorError } from './common.js';
import { AUDIT_MAX_LIMIT, type AuditLog, type AuditQuery, type ActorType } from './types.js';

interface AuditQs {
  actorType?: ActorType;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/** 只读查询 API：GET /api/audit（分页，新的在前）。没有任何写接口。 */
export function registerAuditRoutes(app: FastifyInstance, log: AuditLog): void {
  app.get<{ Querystring: AuditQs }>(
    '/api/audit',
    {
      ...guard('audit:read'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            actorType: { type: 'string', enum: ['owner', 'operator', 'system', 'member'] },
            actorId: { type: 'string', maxLength: 200 },
            action: { type: 'string', maxLength: 200 },
            targetType: { type: 'string', maxLength: 100 },
            targetId: { type: 'string', maxLength: 200 },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            limit: { type: 'integer', minimum: 1, maximum: AUDIT_MAX_LIMIT },
            cursor: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req) => {
      const qs = req.query;
      const q: AuditQuery = {};
      if (qs.actorType || qs.actorId) q.actor = { ...(qs.actorType ? { type: qs.actorType } : {}), ...(qs.actorId ? { id: qs.actorId } : {}) };
      if (qs.targetType || qs.targetId) q.target = { ...(qs.targetType ? { type: qs.targetType } : {}), ...(qs.targetId ? { id: qs.targetId } : {}) };
      if (qs.action) q.action = qs.action;
      if (qs.from) q.from = new Date(qs.from);
      if (qs.to) q.to = new Date(qs.to);
      if (qs.limit) q.limit = qs.limit;
      if (qs.cursor) q.cursor = qs.cursor;
      try {
        const page = await log.query(q);
        return { entries: page.entries.map((e) => ({ ...e, ts: e.ts.toISOString() })), nextCursor: page.nextCursor };
      } catch (err) {
        if (err instanceof InvalidCursorError) throw badRequest('cursor 不合法');
        throw err;
      }
    },
  );
}
