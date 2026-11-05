/**
 * X-08 推送提醒接口。第一版只给所有者范围（所有者令牌 / 方案 A 的所有者账号）；家人账号 403；
 * 能力 push:manage 不进操作员白名单（操作员、客户端令牌 403）。权限在 preValidation 判，先 403 再校验请求体。
 * endpoint 只进不出：任何响应都不回 endpoint。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { guard, scopeOf } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import type { PushService } from './service.js';

function ownerOnly() {
  const g = guard('push:manage', { user: true });
  return {
    config: g.config,
    preValidation: async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      await g.preHandler.call(this, req, reply);
      if (scopeOf(req) !== 'owner') {
        await req.audit('auth.denied', { type: 'route', id: req.routeOptions.url ?? '' }, 'denied', `${req.method} 推送提醒第一版只给所有者`);
        throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
      }
    },
  };
}

const endpoint = { type: 'string', minLength: 9, maxLength: 1024 } as const;
const subscribeBody = {
  type: 'object',
  required: ['endpoint', 'keys'],
  additionalProperties: false,
  properties: {
    endpoint,
    // 浏览器 PushSubscription.toJSON() 带的字段；只认 null
    expirationTime: { type: 'null' },
    keys: {
      type: 'object',
      required: ['p256dh', 'auth'],
      additionalProperties: false,
      properties: { p256dh: { type: 'string', minLength: 80, maxLength: 100 }, auth: { type: 'string', minLength: 16, maxLength: 32 } },
    },
  },
} as const;
const unsubscribeBody = { type: 'object', required: ['endpoint'], additionalProperties: false, properties: { endpoint } } as const;
const statusOut = {
  type: 'object',
  additionalProperties: false,
  properties: { enabled: { type: 'boolean' }, publicKey: { type: ['string', 'null'] }, devices: { type: 'integer' } },
} as const;

export function registerPushRoutes(app: FastifyInstance, svc: PushService): void {
  const g = ownerOnly();

  app.get('/api/push', { ...g, schema: { response: { 200: statusOut } } }, async (req) => svc.status(scopeOf(req)));

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/api/push/subscriptions',
    { ...g, schema: { body: subscribeBody } },
    async (req, reply) => {
      const out = await svc.subscribe(scopeOf(req), { endpoint: req.body.endpoint, p256dh: req.body.keys.p256dh, auth: req.body.keys.auth }, req.audit);
      return reply.status(out.created ? 201 : 200).send({ ok: true });
    },
  );

  // 关掉这台设备：按 endpoint 删（只删本账号的；没有也当成功，重复点不报错）
  app.post<{ Body: { endpoint: string } }>('/api/push/subscriptions/remove', { ...g, schema: { body: unsubscribeBody } }, async (req) => {
    await svc.unsubscribe(scopeOf(req), req.body.endpoint, req.audit);
    return { ok: true };
  });

  app.post('/api/push/test', { ...g, schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: {} } } }, async (req) => svc.sendTest(scopeOf(req)));
}
