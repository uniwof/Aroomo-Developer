/**
 * 会话存库接口（前缀 /api/conversations）。能力 chat:use（和 /api/chat/stream 同一个：不进操作员白名单，也不是客户端令牌范围）。
 * 所有者和家人账号都能用，数据只按 scopeOf(req) 取（D111）：别人的会话和不存在的一样（404）。
 * 没有删除接口：只归档（删除要所有者定）。消息只能由 /api/chat/stream 和一次性导入写（只追加）。
 */
import type { FastifyInstance } from 'fastify';
import { guard, scopeOf } from '../auth/plugin.js';
import type { ConversationService, ConvFilter, ImportInput } from './service.js';
import { CONTENT_MAX, TITLE_MAX } from './types.js';

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: UUID } } as const;
const group = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 64 } } as const;
const model = { type: 'string', maxLength: 120 } as const;
const emptyBody = { type: ['object', 'null'], additionalProperties: false, properties: {} } as const;

export const IMPORT_MAX_CONVERSATIONS = 50;
export const IMPORT_MAX_MESSAGES = 500;

export function registerConversationRoutes(app: FastifyInstance, svc: ConversationService): void {
  const g = guard('chat:use', { user: true });

  app.get<{ Querystring: { filter?: ConvFilter; archived?: boolean; limit?: number; cursor?: string } }>(
    '/api/conversations',
    {
      ...g,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filter: { type: 'string', enum: ['all', 'unread', 'running'] },
            archived: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req) => svc.list(scopeOf(req), { filter: req.query.filter ?? 'all', archived: req.query.archived ?? false, limit: req.query.limit ?? 50, ...(req.query.cursor ? { cursor: req.query.cursor } : {}) }),
  );

  app.post<{ Body: { id?: string; title?: string; model?: string; group?: string[] } }>(
    '/api/conversations',
    {
      ...g,
      // 未声明的字段（含自带 userId / 作者）一律 400
      schema: { body: { type: 'object', additionalProperties: false, properties: { id: UUID, title: { type: 'string', maxLength: TITLE_MAX }, model, group } } },
    },
    async (req, reply) => {
      const out = await svc.create(scopeOf(req), req.body);
      return reply.status(out.created ? 201 : 200).send(out);
    },
  );

  app.post<{ Body: { conversations: ImportInput[] } }>(
    '/api/conversations/import',
    {
      ...g,
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['conversations'],
          additionalProperties: false,
          properties: {
            conversations: {
              type: 'array',
              maxItems: IMPORT_MAX_CONVERSATIONS,
              items: {
                type: 'object',
                required: ['id', 'messages'],
                additionalProperties: false,
                properties: {
                  id: UUID,
                  title: { type: 'string', maxLength: TITLE_MAX },
                  model,
                  group,
                  updatedAt: { type: 'integer', minimum: 0 },
                  messages: {
                    type: 'array',
                    maxItems: IMPORT_MAX_MESSAGES,
                    items: {
                      type: 'object',
                      required: ['role', 'content'],
                      additionalProperties: false,
                      properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string', maxLength: CONTENT_MAX }, at: { type: 'integer', minimum: 0 } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => svc.importLocal(scopeOf(req), req.body.conversations),
  );

  app.get<{ Params: { id: string } }>('/api/conversations/:id', { ...g, schema: { params: idParams } }, async (req) => ({ conversation: await svc.getJson(scopeOf(req), req.params.id) }));

  app.patch<{ Params: { id: string }; Body: { title?: string; archived?: boolean } }>(
    '/api/conversations/:id',
    { ...g, schema: { params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { title: { type: 'string', maxLength: TITLE_MAX }, archived: { type: 'boolean' } } } } },
    async (req) => ({ conversation: await svc.update(scopeOf(req), req.params.id, req.body) }),
  );

  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', { ...g, schema: { params: idParams, body: emptyBody } }, async (req, reply) => {
    await svc.markRead(scopeOf(req), req.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; afterSeq?: number; beforeSeq?: number } }>(
    '/api/conversations/:id/messages',
    {
      ...g,
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200 }, afterSeq: { type: 'integer', minimum: 0 }, beforeSeq: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req) =>
      svc.messages(scopeOf(req), req.params.id, {
        limit: req.query.limit ?? 100,
        ...(req.query.afterSeq !== undefined ? { afterSeq: req.query.afterSeq } : {}),
        ...(req.query.beforeSeq !== undefined ? { beforeSeq: req.query.beforeSeq } : {}),
      }),
  );
}
