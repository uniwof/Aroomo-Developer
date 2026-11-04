/**
 * 资源库接口（D163，M2 最小版）。
 * 读：本人（所有者 / 账号）或带 library:read 的客户端；写（收进）：本人或带 library:write 的客户端（MCP submit_resource）；删：只有本人。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { scopeOf } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import type { LibraryService } from './service.js';
import { BODY_MAX, LIBRARY_KINDS, type LibraryItem, type LibraryKind, TITLE_MAX } from './types.js';

const itemJson = (i: LibraryItem) => ({
  id: i.id,
  kind: i.kind,
  title: i.title,
  url: i.url,
  body: i.body,
  tags: i.tags,
  source: i.source,
  createdAt: i.createdAt.toISOString(),
});
/** 列表只给摘要，正文用 GET /api/library/:id 取 */
const summaryJson = (i: LibraryItem) => ({ ...itemJson(i), body: i.body.slice(0, 200) });

export function registerLibraryRoutes(app: FastifyInstance, svc: LibraryService): void {
  const readCfg = { config: { userRoute: true as const, clientScope: 'library:read' } };
  const writeCfg = { config: { userRoute: true as const, clientScope: 'library:write' } };
  const humanOnly = {
    config: { userRoute: true as const },
    preHandler: async (req: FastifyRequest) => {
      const p = req.principal;
      if (!p || (p.type !== 'owner' && p.type !== 'user')) throw new HttpError(403, 'FORBIDDEN', '只有本人登录后可以删除资源');
    },
  };

  app.get<{ Querystring: { q?: string; kind?: LibraryKind; limit?: number } }>(
    '/api/library',
    {
      ...readCfg,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 200 }, kind: { type: 'string', enum: [...LIBRARY_KINDS] }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
        },
      },
    },
    async (req) => ({ items: (await svc.list(scopeOf(req), req.query)).map(summaryJson) }),
  );

  app.get<{ Params: { id: string } }>('/api/library/:id', { ...readCfg, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } } }, async (req) => ({
    item: itemJson(await svc.get(scopeOf(req), req.params.id)),
  }));

  app.post<{ Body: { kind?: LibraryKind; title?: string; url?: string; body?: string; tags?: string[] } }>(
    '/api/library',
    {
      ...writeCfg,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...LIBRARY_KINDS] },
            title: { type: 'string', maxLength: TITLE_MAX },
            url: { type: 'string', maxLength: 2000 },
            body: { type: 'string', maxLength: BODY_MAX },
            tags: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
          },
        },
      },
    },
    async (req, reply) => {
      const source = req.principal?.type === 'client' ? 'mcp' : 'manual';
      const { item, existed } = await svc.add(scopeOf(req), { ...req.body, source }, req.audit);
      return reply.status(existed ? 200 : 201).send({ item: itemJson(item), existed });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/library/:id', { ...humanOnly, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } } }, async (req, reply) => {
    await svc.delete(scopeOf(req), req.params.id, req.audit);
    return reply.status(204).send();
  });
}
