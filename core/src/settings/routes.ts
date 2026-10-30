import type { FastifyInstance } from 'fastify';
import { guard, scopeOf } from '../auth/plugin.js';
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

export function registerSettingsRoutes(
  app: FastifyInstance,
  ownerLead: LeadService,
  security: SecurityService,
  /** 账号用户的负责人服务（只读写本人的成员与设置）；不传则账号不能用 */
  leadForUser?: (userId: string) => LeadService,
): void {
  const leadOf = (req: import('fastify').FastifyRequest): LeadService => {
    const scope = scopeOf(req);
    return scope === 'owner' ? ownerLead : (leadForUser as (u: string) => LeadService)(scope);
  };
  app.get('/api/settings/lead', { ...guard('members:read', { user: true }), schema: { response: { 200: leadOut } } }, async (req) => leadOf(req).get());
  app.put<{ Body: { leadId: string | null } }>(
    '/api/settings/lead',
    {
      ...guard('settings:write', { user: true }),
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
    async (req) => leadOf(req).set(req.body.leadId, req.audit),
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
