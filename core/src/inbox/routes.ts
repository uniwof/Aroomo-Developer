/** 收件箱 API（前缀 /api/inbox，Issue #7）。 */
import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import { actorKey, principalCan } from '../auth/tokens.js';
import { CONFIRM_KINDS } from '../confirm/confirm.js';
import type { CreateInboxInput, InboxService } from './service.js';
import { INBOX_GROUPS, type InboxGroup, type InboxItem, type InboxStatus, URGENCIES } from './types.js';

export function inboxJson(i: InboxItem) {
  return {
    ...i,
    createdAt: i.createdAt.toISOString(),
    ...(i.resolvedAt ? { resolvedAt: i.resolvedAt.toISOString() } : {}),
  };
}

const UUID = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } as const;

const actionSchema = {
  type: 'object',
  required: ['id', 'label'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', maxLength: 64 },
    label: { type: 'string', maxLength: 64 },
    confirm: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...CONFIRM_KINDS] },
        consequences: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
      },
    },
  },
} as const;

export function registerInboxRoutes(app: FastifyInstance, svc: InboxService): void {
  /** 发卡片（D62：操作员允许项「向收件箱发卡片」；主人也可用）。同 related + kind 的 open 卡片去重。 */
  app.post<{ Body: CreateInboxInput }>(
    '/api/inbox',
    {
      ...guard('inbox:post'),
      schema: {
        body: {
          type: 'object',
          required: ['group', 'kind', 'title'],
          additionalProperties: false,
          properties: {
            group: { type: 'string', enum: [...INBOX_GROUPS] },
            kind: { type: 'string', minLength: 1, maxLength: 64 },
            urgency: { type: 'string', enum: [...URGENCIES] },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            summary: { type: 'string', maxLength: 4000 },
            related: {
              type: 'object',
              required: ['type', 'id'],
              additionalProperties: false,
              properties: { type: { type: 'string', maxLength: 64 }, id: { type: 'string', maxLength: 200 } },
            },
            actions: { type: 'array', maxItems: 5, items: actionSchema },
          },
        },
      },
    },
    async (req, reply) => {
      const out = await svc.createInboxItem(req.body, req.audit);
      return reply.status(out.created ? 201 : 200).send({ item: inboxJson(out.item), created: out.created });
    },
  );

  app.get<{ Querystring: { group?: InboxGroup; status?: InboxStatus } }>(
    '/api/inbox',
    {
      ...guard('inbox:read'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            group: { type: 'string', enum: [...INBOX_GROUPS] },
            status: { type: 'string', enum: ['open', 'done', 'dismissed', 'expired'] },
          },
        },
      },
    },
    async (req) => {
      const { group, status } = req.query;
      if (group) return { items: (await svc.list({ group, ...(status ? { status } : {}) })).map(inboxJson) };
      const all = await svc.list(status ? { status } : {});
      const groups = Object.fromEntries(INBOX_GROUPS.map((g) => [g, all.filter((i) => i.group === g).map(inboxJson)]));
      return { groups };
    },
  );

  app.get('/api/inbox/unread-count', { ...guard('inbox:read') }, async () => svc.unreadCount());

  app.post<{ Params: { id: string; actionId: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/inbox/:id/actions/:actionId',
    {
      ...guard('inbox:act'),
      schema: {
        params: {
          type: 'object',
          required: ['id', 'actionId'],
          properties: { id: UUID, actionId: { type: 'string', maxLength: 64 } },
        },
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { confirmToken: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (req) => {
      const p = req.principal!;
      const item = await svc.act(
        req.params.id,
        req.params.actionId,
        {
          ...(req.body?.confirmToken ? { confirmToken: req.body.confirmToken } : {}),
          actor: actorKey(p),
          canConfirmImportant: principalCan(p, 'confirm:important'),
        },
        req.audit,
      );
      return { item: inboxJson(item) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/inbox/:id/dismiss',
    {
      ...guard('inbox:act'),
      schema: { params: { type: 'object', required: ['id'], properties: { id: UUID } } },
    },
    async (req) => ({ item: inboxJson(await svc.dismiss(req.params.id, req.audit)) }),
  );

  app.post<{ Body: { ids: string[] } }>(
    '/api/inbox/dismiss',
    {
      ...guard('inbox:act'),
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: { ids: { type: 'array', minItems: 1, maxItems: 500, items: UUID } },
        },
      },
    },
    async (req) => svc.dismissMany(req.body.ids, req.audit),
  );
}
