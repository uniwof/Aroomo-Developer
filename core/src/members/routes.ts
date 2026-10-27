/**
 * 成员 API（前缀 /api/members，Issue #5）。P0 单用户：写操作需要相应能力（主人拥有全部；
 * 操作员白名单只含 members:read，D36）。
 */
import type { FastifyInstance } from 'fastify';
import { requireCapability } from '../auth/plugin.js';
import type { CreateMemberInput, MembersService, UpdateMemberInput } from './service.js';
import { CAPABILITY_TAGS, type Member } from './types.js';

export function memberJson(m: Member) {
  return {
    id: m.id,
    name: m.name,
    aliases: m.aliases,
    capabilityTags: m.capabilityTags,
    enabled: m.enabled,
    pinned: m.pinned,
    sortOrder: m.sortOrder,
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

export function registerMemberRoutes(app: FastifyInstance, svc: MembersService): void {
  app.get<{ Querystring: { deleted?: boolean } }>(
    '/api/members',
    {
      preHandler: requireCapability('members:read'),
      schema: { querystring: { type: 'object', properties: { deleted: { type: 'boolean' } } } },
    },
    async (req) => ({ members: (await svc.list({ deleted: req.query.deleted === true })).map(memberJson) }),
  );

  app.post<{ Body: CreateMemberInput }>(
    '/api/members',
    {
      preHandler: requireCapability('members:write'),
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { id: { type: 'string', maxLength: 64 }, ...editable },
        },
      },
    },
    async (req, reply) => reply.status(201).send({ member: memberJson(await svc.create(req.body, req.audit)) }),
  );

  app.patch<{ Params: { id: string }; Body: UpdateMemberInput }>(
    '/api/members/:id',
    {
      preHandler: requireCapability('members:write'),
      schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: editable } },
    },
    async (req) => ({ member: memberJson(await svc.update(req.params.id, req.body, req.audit)) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/members/:id',
    { preHandler: requireCapability('members:delete'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.softDelete(req.params.id, req.audit)) }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/members/:id/restore',
    { preHandler: requireCapability('members:delete'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.restore(req.params.id, req.audit)) }),
  );

  app.post<{ Params: { id: string }; Body: { confirm?: boolean } | undefined }>(
    '/api/members/:id/purge',
    {
      preHandler: requireCapability('members:purge'),
      schema: { params: idParam, body: { type: ['object', 'null'], properties: { confirm: { type: 'boolean' } } } },
    },
    async (req, reply) => {
      await svc.purge(req.params.id, req.body?.confirm === true, req.audit);
      return reply.status(204).send();
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/members/:id/pin',
    { preHandler: requireCapability('members:write'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.setPinned(req.params.id, true, req.audit)) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/members/:id/pin',
    { preHandler: requireCapability('members:write'), schema: { params: idParam } },
    async (req) => ({ member: memberJson(await svc.setPinned(req.params.id, false, req.audit)) }),
  );

  app.put<{ Body: { ids: string[] } }>(
    '/api/members/order',
    {
      preHandler: requireCapability('members:write'),
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
