import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import type { LeadService } from './lead.js';

const leadOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    leadId: { type: ['string', 'null'] },
    effectiveLeadId: { type: ['string', 'null'] },
    auto: { type: 'boolean' },
  },
} as const;

export function registerSettingsRoutes(app: FastifyInstance, lead: LeadService): void {
  app.get('/api/settings/lead', { ...guard('members:read'), schema: { response: { 200: leadOut } } }, async () => lead.get());
  app.put<{ Body: { leadId: string | null } }>(
    '/api/settings/lead',
    {
      ...guard('settings:write'),
      schema: {
        body: {
          type: 'object',
          required: ['leadId'],
          additionalProperties: false,
          properties: { leadId: { type: ['string', 'null'], maxLength: 64 } },
        },
        response: { 200: leadOut },
      },
    },
    async (req) => lead.set(req.body.leadId, req.audit),
  );
}
