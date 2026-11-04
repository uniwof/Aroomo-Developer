/**
 * 账号接口（B1）。
 * 公开（无需令牌，限速）：POST /auth/login、POST /auth/accept（邀请注册 / 重置密码）。
 * 本人：GET /api/auth/me、POST /api/auth/logout、/logout-all、/password。
 * 管理员（所有者令牌或 admin 账号）：/api/users 系列。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminGuard, userGuard } from '../auth/plugin.js';
import type { AuditLog } from '../audit/types.js';
import { bindAudit } from '../audit/common.js';
import { HttpError } from '../http/errors.js';
import { clearSessionCookie, isSecureRequest, readSessionCookie, sessionCookie } from '../auth/session-cookie.js';
import type { UsersService } from './service.js';
import type { UserRole } from './types.js';

const userOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

const loginOut = {
  type: 'object',
  additionalProperties: false,
  properties: { token: { type: 'string' }, expiresAt: { type: 'string' }, user: userOut },
} as const;

export function registerUserRoutes(app: FastifyInstance, svc: UsersService, auditLog: AuditLog): void {
  const sysAudit = bindAudit(auditLog, { type: 'system', id: 'auth' });

  /** body.cookie=true：令牌只放进 HttpOnly Cookie，响应里不再带 token（页面脚本拿不到） */
  const viaCookie = <T extends { token: string; expiresAt: string }>(req: FastifyRequest, reply: FastifyReply, on: boolean, out: T): Omit<T, 'token'> | T => {
    if (!on) return out;
    const { token, ...rest } = out;
    void reply.header('set-cookie', sessionCookie(token, new Date(out.expiresAt), new Date(), isSecureRequest(req)));
    return rest;
  };

  app.post<{ Body: { email: string; password: string; cookie?: boolean } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 400 }, cookie: { type: 'boolean' } },
        },
        response: { 200: loginOut },
      },
    },
    async (req, reply) => viaCookie(req, reply, req.body.cookie === true, await svc.login(req.body.email, req.body.password, req.ip, sysAudit)),
  );

  app.post<{ Body: { token: string; password: string; displayName?: string; cookie?: boolean } }>(
    '/auth/accept',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', maxLength: 200 },
            password: { type: 'string', maxLength: 400 },
            displayName: { type: 'string', maxLength: 64 },
            cookie: { type: 'boolean' },
          },
        },
        response: { 200: loginOut },
      },
    },
    async (req, reply) => viaCookie(req, reply, req.body.cookie === true, await svc.accept(req.body.token, req.body.password, req.body.displayName, sysAudit)),
  );

  // ---- 本人 ----
  app.get('/api/auth/me', { ...userGuard() }, async (req) => {
    const p = req.principal!;
    if (p.type === 'user') return { kind: 'user', user: await svc.me(p.userId) };
    return { kind: p.type, id: p.id };
  });

  const needUser = (req: { principal: import('../auth/tokens.js').Principal | null }) => {
    const p = req.principal;
    if (!p || p.type !== 'user') throw new HttpError(403, 'FORBIDDEN', '只有账号登录后可以执行这个操作');
    return p;
  };

  app.post('/api/auth/logout', { ...userGuard() }, async (req, reply) => {
    await svc.logout(needUser(req), req.audit);
    if (readSessionCookie(req.headers.cookie)) void reply.header('set-cookie', clearSessionCookie(isSecureRequest(req)));
    return reply.status(204).send();
  });
  app.post('/api/auth/logout-all', { ...userGuard() }, async (req, reply) => {
    await svc.logoutAll(needUser(req), req.audit);
    if (readSessionCookie(req.headers.cookie)) void reply.header('set-cookie', clearSessionCookie(isSecureRequest(req)));
    return reply.status(204).send();
  });
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/password',
    {
      ...userGuard(),
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: { currentPassword: { type: 'string', maxLength: 400 }, newPassword: { type: 'string', maxLength: 400 } },
        },
      },
    },
    async (req, reply) => {
      await svc.changePassword(needUser(req), req.body.currentPassword, req.body.newPassword, req.audit);
      return reply.status(204).send();
    },
  );

  // ---- 管理员 ----
  const createdBy = (req: { principal: import('../auth/tokens.js').Principal | null }) =>
    req.principal?.type === 'user' ? `user:${req.principal.userId}` : 'owner';

  app.get('/api/users', { ...adminGuard() }, async () => ({ users: await svc.list(), invites: await svc.listOpenInvites() }));

  app.post<{ Body: { email: string; role?: UserRole } }>(
    '/api/users/invites',
    {
      ...adminGuard(),
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: { type: 'string', maxLength: 254 }, role: { type: 'string', enum: ['admin', 'user'] } },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await svc.invite(req.body.email, req.body.role ?? 'user', createdBy(req), req.audit)),
  );

  const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
  const actorUser = (req: { principal: import('../auth/tokens.js').Principal | null }) => (req.principal?.type === 'user' ? req.principal.userId : null);

  app.post<{ Params: { id: string } }>('/api/users/:id/disable', { ...adminGuard(), schema: { params: idParams } }, async (req) => ({
    user: await svc.setStatus(req.params.id, 'disabled', actorUser(req), req.audit),
  }));
  app.post<{ Params: { id: string } }>('/api/users/:id/enable', { ...adminGuard(), schema: { params: idParams } }, async (req) => ({
    user: await svc.setStatus(req.params.id, 'active', actorUser(req), req.audit),
  }));
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-link', { ...adminGuard(), schema: { params: idParams } }, async (req, reply) =>
    reply.status(201).send(await svc.issueReset(req.params.id, createdBy(req), req.audit)),
  );
}
