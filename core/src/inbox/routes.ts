import type { FastifyInstance } from 'fastify';
import {
  InboxInvalidTokenError,
  InboxService,
} from './service.js';
import {
  InboxActionNotFoundError,
  InboxConflictError,
  InboxNotFoundError,
} from './store.js';
import type { InboxGroup } from './types.js';

export function registerInboxRoutes(app: FastifyInstance, inboxService: InboxService): void {
  // GET /api/inbox/items
  app.get<{ Querystring: { group?: InboxGroup } }>(
    '/api/inbox/items',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            group: { type: 'string', enum: ['decision', 'candidate', 'brief'] },
          },
        },
      },
    },
    async (req) => {
      const items = await inboxService.listItems({ group: req.query.group });
      return { items };
    },
  );

  // GET /api/inbox/unread-count
  app.get('/api/inbox/unread-count', async () => {
    const count = await inboxService.getUnreadCount();
    return { count };
  });

  // POST /api/inbox/items/:id/action
  app.post<{
    Params: { id: string };
    Body: { actionId: string; confirmToken?: string };
  }>(
    '/api/inbox/items/:id/action',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['actionId'],
          properties: {
            actionId: { type: 'string', minLength: 1 },
            confirmToken: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await inboxService.executeAction(
          req.params.id,
          req.body.actionId,
          req.body.confirmToken,
        );
        if ('needsConfirm' in result) {
          return reply.status(200).send(result);
        }
        return reply.status(200).send({ item: result.item });
      } catch (err) {
        if (err instanceof InboxNotFoundError) {
          return reply.status(404).send({ error: 'Not Found', message: err.message });
        }
        if (err instanceof InboxActionNotFoundError) {
          return reply.status(400).send({ error: 'Bad Request', message: err.message });
        }
        if (err instanceof InboxConflictError) {
          return reply.status(409).send({ error: 'Conflict', message: err.message });
        }
        if (err instanceof InboxInvalidTokenError) {
          return reply.status(400).send({ error: 'Bad Request', message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /api/inbox/items/:id/dismiss
  app.post<{ Params: { id: string } }>(
    '/api/inbox/items/:id/dismiss',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const item = await inboxService.dismissItem(req.params.id);
        return { item };
      } catch (err) {
        if (err instanceof InboxNotFoundError) {
          return reply.status(404).send({ error: 'Not Found', message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /api/inbox/batch-dismiss
  app.post<{
    Body?: { ids?: string[]; group?: InboxGroup };
  }>(
    '/api/inbox/batch-dismiss',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            group: { type: 'string', enum: ['decision', 'candidate', 'brief'] },
          },
        },
      },
    },
    async (req) => {
      const dismissedCount = await inboxService.batchDismissItems(req.body);
      return { dismissedCount };
    },
  );
}
