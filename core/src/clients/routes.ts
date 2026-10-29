/**
 * 客户端令牌管理（人用）：POST/GET /api/clients、DELETE /api/clients/:id、POST /api/clients/revoke-all。
 * 客户端令牌自己不能管理令牌（它没有 userRoute）；GET /api/clients/self 让客户端看自己的名字和范围。
 */
import type { FastifyInstance } from 'fastify';
import { scopeOf, userGuard } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import { CLIENT_SCOPES, type PublicClient } from './types.js';
import type { ClientTokenService } from './service.js';

export function registerClientRoutes(app: FastifyInstance, svc: ClientTokenService): void {
  /** 只有人（所有者令牌或账号会话）可以管理；操作员、客户端不行 */
  const human = async (req: import('fastify').FastifyRequest) => {
    const p = req.principal;
    if (!p || (p.type !== 'owner' && p.type !== 'user')) throw new HttpError(403, 'FORBIDDEN', '只有本人登录后可以管理客户端令牌');
  };

  app.post<{ Body: { name: string; scopes: string[]; expiresInDays?: number; rateLimitPerMin?: number } }>(
    '/api/clients',
    {
      ...userGuard(),
      preHandler: human,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'scopes'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 64 },
            scopes: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
            expiresInDays: { type: 'integer', minimum: 1, maximum: 3650 },
            rateLimitPerMin: { type: 'integer', minimum: 1, maximum: 6000 },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await svc.create(scopeOf(req), req.body, req.audit)),
  );

  app.get('/api/clients', { ...userGuard(), preHandler: human }, async (req) => ({ clients: await svc.list(scopeOf(req)), availableScopes: CLIENT_SCOPES }));

  app.delete<{ Params: { id: string } }>(
    '/api/clients/:id',
    { ...userGuard(), preHandler: human, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      await svc.revoke(scopeOf(req), req.params.id, req.audit);
      return reply.status(204).send();
    },
  );

  app.post('/api/clients/revoke-all', { ...userGuard(), preHandler: human }, async (req) => ({ revoked: await svc.revokeAll(scopeOf(req), req.audit) }));

  // 客户端自己看自己（不泄露令牌）
  app.get('/api/clients/self', { config: { clientSelf: true } }, async (req): Promise<{ client: Pick<PublicClient, 'id' | 'name' | 'scopes'> }> => {
    const p = req.principal;
    if (!p || p.type !== 'client') throw new HttpError(403, 'FORBIDDEN', '只有客户端令牌可以查看自己');
    return { client: { id: p.clientId, name: p.name, scopes: [...p.scopes] } };
  });
}
