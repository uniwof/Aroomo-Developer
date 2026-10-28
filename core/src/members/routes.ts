/**
 * 成员 API（前缀 /api/members，Issue #5）。P0 单用户：写操作需要相应能力（主人拥有全部；
 * 操作员白名单只含 members:read，D36）。
 */
import type { FastifyInstance } from 'fastify';
import type { AuditFn } from '../audit/types.js';
import { confirmCtx, guard } from '../auth/plugin.js';
import type { CreateMemberInput, MembersService, UpdateMemberInput } from './service.js';
import { CAPABILITY_TAGS, type Member } from './types.js';
import { leadEligibility } from './caps.js';

export function memberJson(m: Member) {
  const lead = leadEligibility(m);
  return {
    id: m.id,
    name: m.name,
    aliases: m.aliases,
    capabilityTags: m.capabilityTags,
    enabled: m.enabled,
    pinned: m.pinned,
    sortOrder: m.sortOrder,
    status: m.status,
    modelCaps: m.modelCaps ? { mode: m.modelCaps.mode, maxInputTokens: m.modelCaps.maxInputTokens, supportsTools: m.modelCaps.supportsTools } : null,
    leadEligible: lead.eligible,
    leadIneligibleReason: lead.reason,
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const editable = {
  name: { type: 'string', maxLength: 200 },
  aliases: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
  capabilityTags: { type: 'array', maxItems: 20, items: { type: 'string', enum: [...CAPABILITY_TAGS] } },
  enabled: { type: 'boolean' },
} as const;

export interface MemberRouteHooks {
  /** 一键入职（候选 → 在职）；由候选流程实现（同时处理收件箱里的候选卡片） */
  onboard?: (id: string, audit: AuditFn) => Promise<Member>;
  /** 手动添加成员之后（例如：按名字去 LiteLLM 取模型事实），返回最新的成员 */
  afterCreate?: (m: Member) => Promise<Member>;
}

export function registerMemberRoutes(app: FastifyInstance, svc: MembersService, hooks: MemberRouteHooks = {}): void {
  app.get<{ Querystring: { deleted?: boolean } }>(
    '/api/members',
    {
      ...guard('members:read'),
      schema: { querystring: { type: 'object', properties: { deleted: { type: 'boolean' } } } },
    },
    async (req) => ({ members: (await svc.list({ deleted: req.query.deleted === true })).map(memberJson) }),
  );

  app.post<{ Body: CreateMemberInput }>(
    '/api/members',
    {
      ...guard('members:write'),
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { id: { type: 'string', maxLength: 64 }, ...editable },
        },
      },
    },
    async (req, reply) => {
      let m = await svc.create(req.body, req.audit);
      if (hooks.afterCreate) m = await hooks.afterCreate(m).catch(() => m);
      return reply.status(201).send({ member: memberJson(m) });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateMemberInput }>(
    '/api/members/:id',
    {
      ...guard('members:write'),
      schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: editable } },
    },
    async (req) => ({ member: memberJson(await svc.update(req.params.id, req.body, req.audit)) }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/members/:id/onboard',
    { ...guard('members:write'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await (hooks.onboard ?? ((id, audit) => svc.onboard(id, audit)))(req.params.id, req.audit)) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/members/:id',
    { ...guard('members:delete'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.softDelete(req.params.id, req.audit)) }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/members/:id/restore',
    { ...guard('members:delete'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.restore(req.params.id, req.audit)) }),
  );

  app.post<{ Params: { id: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/members/:id/purge',
    {
      ...guard('members:purge'),
      schema: {
        params: idParam,
        body: { type: ['object', 'null'], additionalProperties: false, properties: { confirmToken: { type: 'string', minLength: 1, maxLength: 128 } } },
      },
    },
    async (req, reply) => {
      await svc.purge(req.params.id, confirmCtx(req.principal!, req.body?.confirmToken), req.audit);
      return reply.status(204).send();
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/members/:id/pin',
    { ...guard('members:write'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.setPinned(req.params.id, true, req.audit)) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/members/:id/pin',
    { ...guard('members:write'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.setPinned(req.params.id, false, req.audit)) }),
  );

  app.put<{ Body: { ids: string[] } }>(
    '/api/members/order',
    {
      ...guard('members:write'),
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: { ids: { type: 'array', maxItems: 1000, items: { type: 'string', maxLength: 64 } } },
        },
      },
    },
    async (req) => ({ members: (await svc.reorder(req.body.ids, req.audit)).map(memberJson) }),
  );
}
