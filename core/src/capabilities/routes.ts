import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import { scopeOf } from '../auth/plugin.js';
import type { CapabilityService } from './service.js';
import type { TrialService } from './trials.js';
import type { CapabilityAccess, CapabilityKind } from './types.js';

/**
 * GET /api/capabilities?kind=text|image|video&access=free|trial|paid
 * 能力清单：各能力计数、永久免费/试用徽标、额度（查不到 quotaKnown=false，界面显示「未知」）。只读，不含 Key。
 */
export function registerCapabilityRoutes(app: FastifyInstance, svc: CapabilityService, trialsFor?: (userId: string) => TrialService): void {
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
    async (req) => {
      const out = svc.list(req.query);
      if (!trialsFor) return out;
      const tr = trialsFor(scopeOf(req));
      return { ...out, items: await tr.decorate(out.items), tools: await tr.decorate(out.tools) };
    },
  );

  /** PUT /api/capabilities/:id/trial {endsAt:'2026-12-31'|null}：填/清试用到期日 */
  if (trialsFor)
    app.put<{ Params: { id: string }; Body: { endsAt: string | null } }>(
      '/api/capabilities/:id/trial',
      {
        ...guard('members:write', { user: true }),
        schema: {
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 120 } } },
          body: { type: 'object', required: ['endsAt'], additionalProperties: false, properties: { endsAt: { type: ['string', 'null'], maxLength: 10 } } },
        },
      },
      async (req) => trialsFor(scopeOf(req)).set(req.params.id, req.body.endsAt, req.audit),
    );
}
