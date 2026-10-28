import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import type { LeadService } from './lead.js';
import type { SecurityService } from './security.js';

const leadOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    leadId: { type: ['string', 'null'] },
    effectiveLeadId: { type: ['string', 'null'] },
    auto: { type: 'boolean' },
  },
} as const;

const securityOut = {
  type: 'object',
  additionalProperties: false,
  properties: { sensitiveProtect: { type: 'boolean' } },
} as const;

export function registerSettingsRoutes(app: FastifyInstance, lead: LeadService, security: SecurityService): void {
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

  // 敏感内容保护（D38）：读取用普通设置权限；修改是操作员禁止项（D62），只有主人能改
  app.get('/api/settings/security', { ...guard('settings:write'), schema: { response: { 200: securityOut } } }, async () => security.get());
  app.put<{ Body: { sensitiveProtect: boolean } }>(
    '/api/settings/security',
    {
      ...guard('settings:sensitive:write'),
      schema: {
        body: { type: 'object', required: ['sensitiveProtect'], additionalProperties: false, properties: { sensitiveProtect: { type: 'boolean' } } },
        response: { 200: securityOut },
      },
    },
    async (req) => security.set({ sensitiveProtect: req.body.sensitiveProtect }, req.audit),
  );
}
