/**
 * 保险箱接口（B2）。只有本人（所有者令牌或账号会话）可用；操作员和客户端令牌一律 403。
 * 列表 / 详情永远没有明文；明文只经「查看」接口，且需要重要确认（凭据类，D63）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { confirmCtx, scopeOf } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import type { VaultService } from './service.js';
import { SECRET_KINDS, VALUE_MAX } from './types.js';

export function registerVaultRoutes(app: FastifyInstance, svc: VaultService): void {
  const cfg = {
    config: { userRoute: true as const },
    preHandler: async (req: FastifyRequest) => {
      const p = req.principal;
      if (!p || (p.type !== 'owner' && p.type !== 'user')) throw new HttpError(403, 'FORBIDDEN', '只有本人登录后可以使用保险箱');
    },
  };
  const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
  const confirmToken = { type: 'string', minLength: 1, maxLength: 128 } as const;
  const noStore = (reply: { header: (k: string, v: string) => unknown }) => reply.header('cache-control', 'no-store');

  app.get('/api/vault', { ...cfg }, async (req, reply) => {
    noStore(reply);
    return { secrets: await svc.list(scopeOf(req)) };
  });

  app.post<{ Body: { name: string; kind: string; value: string } }>(
    '/api/vault',
    {
      ...cfg,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'kind', 'value'],
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 64 }, kind: { type: 'string', enum: [...SECRET_KINDS] }, value: { type: 'string', maxLength: VALUE_MAX } },
        },
      },
    },
    async (req, reply) => {
      noStore(reply);
      return reply.status(201).send({ secret: await svc.create(scopeOf(req), req.body, req.audit) });
    },
  );

  app.put<{ Params: { id: string }; Body: { value: string } }>(
    '/api/vault/:id',
    {
      ...cfg,
      schema: { params: idParam, body: { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: 'string', maxLength: VALUE_MAX } } } },
    },
    async (req, reply) => {
      noStore(reply);
      return { secret: await svc.replace(scopeOf(req), req.params.id, req.body.value, req.audit) };
    },
  );

  app.post<{ Params: { id: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/vault/:id/reveal',
    { ...cfg, schema: { params: idParam, body: { type: ['object', 'null'], additionalProperties: false, properties: { confirmToken } } } },
    async (req, reply) => {
      noStore(reply);
      const value = await svc.reveal(scopeOf(req), req.params.id, confirmCtx(req.principal!, req.body?.confirmToken), req.audit);
      return { value };
    },
  );

  app.delete<{ Params: { id: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/vault/:id',
    { ...cfg, schema: { params: idParam, body: { type: ['object', 'null'], additionalProperties: false, properties: { confirmToken } } } },
    async (req, reply) => {
      await svc.delete(scopeOf(req), req.params.id, confirmCtx(req.principal!, req.body?.confirmToken), req.audit);
      return reply.status(204).send();
    },
  );
}
