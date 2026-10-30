import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import type { CapabilityService } from './service.js';
import type { CapabilityAccess, CapabilityKind } from './types.js';

/**
 * GET /api/capabilities?kind=text|image|video&access=free|trial|paid
 * 能力清单：各能力计数、永久免费/试用徽标、额度（查不到 quotaKnown=false，界面显示「未知」）。只读，不含 Key。
 */
export function registerCapabilityRoutes(app: FastifyInstance, svc: CapabilityService): void {
  app.get<{ Querystring: { kind?: CapabilityKind; access?: CapabilityAccess } }>(
    '/api/capabilities',
    {
      ...guard('members:read', { user: true }),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string', enum: ['text', 'image', 'video'] }, access: { type: 'string', enum: ['free', 'trial', 'paid'] } },
        },
      },
    },
    async (req) => svc.list(req.query),
  );
}
