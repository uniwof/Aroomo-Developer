/** 收件箱 API（前缀 /api/inbox，Issue #7）。 */
import type { FastifyInstance } from 'fastify';
import { requireCapability } from '../auth/plugin.js';
import { principalCan } from '../auth/tokens.js';
import type { InboxService } from './service.js';
import { INBOX_GROUPS, type InboxGroup, type InboxItem, type InboxStatus } from './types.js';

export function inboxJson(i: InboxItem) {
  return {
    ...i,
    createdAt: i.createdAt.toISOString(),
    ...(i.resolvedAt ? { resolvedAt: i.resolvedAt.toISOString() } : {}),
  };
}

const UUID = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } as const;

export function registerInboxRoutes(app: FastifyInstance, svc: InboxService): void {
  app.get<{ Querystring: { group?: InboxGroup; status?: InboxStatus } }>(
    '/api/inbox',
    {
      preHandler: requireCapability('inbox:read'),
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

  app.get('/api/inbox/unread-count', { preHandler: requireCapability('inbox:read') }, async () => svc.unreadCount());

  app.post<{ Params: { id: string; actionId: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/inbox/:id/actions/:actionId',
    {
      preHandler: requireCapability('inbox:act'),
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
      const out = await svc.act(
        req.params.id,
        req.params.actionId,
        {
          ...(req.body?.confirmToken ? { confirmToken: req.body.confirmToken } : {}),
          actorKey: p.type === 'owner' ? 'owner' : `operator:${p.id}`,
          canConfirmIrreversible: principalCan(p, 'inbox:confirm-irreversible'),
        },
        req.audit,
      );
      if (out.needsConfirm) return { needsConfirm: true, confirmToken: out.confirmToken, expiresAt: out.expiresAt.toISOString() };
      return { needsConfirm: false, item: inboxJson(out.item) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/inbox/:id/dismiss',
    {
      preHandler: requireCapability('inbox:act'),
      schema: { params: { type: 'object', required: ['id'], properties: { id: UUID } } },
    },
    async (req) => ({ item: inboxJson(await svc.dismiss(req.params.id, req.audit)) }),
  );

  app.post<{ Body: { ids: string[] } }>(
    '/api/inbox/dismiss',
    {
      preHandler: requireCapability('inbox:act'),
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
