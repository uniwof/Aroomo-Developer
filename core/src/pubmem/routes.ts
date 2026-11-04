/**
 * 公共记忆接口（B6）。读：本人（所有者 / 账号）或带 memory:read 范围的客户端令牌；写：只有本人。
 * 操作员、没有该范围的客户端一律 403。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { scopeOf } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import type { PubMemService } from './service.js';
import type { MemoryEntry } from './types.js';
import { BODY_MAX } from './types.js';

const entryJson = (e: MemoryEntry) => ({ topic: e.topic, title: e.title, body: e.body, version: e.version, updatedAt: e.updatedAt.toISOString() });
const summaryJson = (e: MemoryEntry) => ({ topic: e.topic, title: e.title, version: e.version, updatedAt: e.updatedAt.toISOString() });

export function registerPubMemRoutes(app: FastifyInstance, svc: PubMemService): void {
  /** 读：所有者令牌、账号、带 memory:read 的客户端（范围由 clientScope 在鉴权钩子里检查）；操作员由钩子拒绝 */
  const readCfg = { config: { userRoute: true as const, clientScope: 'memory:read' } };
  /** 写：只有人（所有者令牌或账号会话） */
  const writeCfg = {
    config: { userRoute: true as const },
    preHandler: async (req: FastifyRequest) => {
      const p = req.principal;
      if (!p || (p.type !== 'owner' && p.type !== 'user')) throw new HttpError(403, 'FORBIDDEN', '只有本人登录后可以修改公共记忆');
    },
  };
  const topicParam = { type: 'object', required: ['topic'], properties: { topic: { type: 'string', maxLength: 64 } } } as const;

  app.get('/api/memory', { ...readCfg }, async (req) => ({ topics: (await svc.list(scopeOf(req))).map(summaryJson) }));

  app.get<{ Params: { topic: string } }>('/api/memory/:topic', { ...readCfg, schema: { params: topicParam } }, async (req) => ({
    memory: entryJson(await svc.get(scopeOf(req), req.params.topic)),
  }));

  app.put<{ Params: { topic: string }; Body: { title: string; body: string } }>(
    '/api/memory/:topic',
    {
      ...writeCfg,
      schema: {
        params: topicParam,
        body: {
          type: 'object',
          required: ['title', 'body'],
          additionalProperties: false,
          properties: { title: { type: 'string', maxLength: 128 }, body: { type: 'string', maxLength: BODY_MAX } },
        },
      },
    },
    async (req) => ({ memory: entryJson(await svc.put(scopeOf(req), req.params.topic, req.body.title, req.body.body, req.audit)) }),
  );

  app.delete<{ Params: { topic: string } }>('/api/memory/:topic', { ...writeCfg, schema: { params: topicParam } }, async (req, reply) => {
    await svc.delete(scopeOf(req), req.params.topic, req.audit);
    return reply.status(204).send();
  });

  app.get<{ Params: { topic: string } }>('/api/memory/:topic/versions', { ...writeCfg, schema: { params: topicParam } }, async (req) => ({
    versions: (await svc.versions(scopeOf(req), req.params.topic)).map((v) => ({ version: v.version, title: v.title, body: v.body, createdAt: v.createdAt.toISOString() })),
  }));

  app.post<{ Params: { topic: string }; Body: { version: number } }>(
    '/api/memory/:topic/rollback',
    {
      ...writeCfg,
      schema: { params: topicParam, body: { type: 'object', required: ['version'], additionalProperties: false, properties: { version: { type: 'integer', minimum: 1 } } } },
    },
    async (req) => ({ memory: entryJson(await svc.rollback(scopeOf(req), req.params.topic, req.body.version, req.audit)) }),
  );
}
