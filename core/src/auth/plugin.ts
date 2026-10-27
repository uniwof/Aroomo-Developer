/**
 * /api/* 的鉴权：Bearer 令牌 → Principal；每个路由用 requireCapability 声明所需能力。
 * P0 单用户：requireOwner 即「主人令牌」（Issue #5 的占位钩子），后续接入登录态（PRODUCT §11.2 第 9 条）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { bindAudit } from '../audit/common.js';
import type { AuditActor, AuditFn, AuditLog } from '../audit/types.js';
import { HttpError } from '../http/errors.js';
import type { Capability } from './capabilities.js';
import { type Principal, principalCan } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** 已绑定当前操作者的审计回调 */
    audit: AuditFn;
  }
}

export function actorOf(p: Principal): AuditActor {
  return p.type === 'owner' ? { type: 'owner', id: 'owner' } : { type: 'operator', id: p.id };
}

export interface AuthOptions {
  verify: (token: string) => Promise<Principal | null>;
  auditLog: AuditLog;
  /** 未配置主人令牌时，/api 一律 503（避免「无令牌也能用」的默认开放）。 */
  ownerConfigured: boolean;
}

const noAudit: AuditFn = async () => undefined;

export function installAuth(app: FastifyInstance, opts: AuthOptions): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('audit', noAudit);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/')) return;
    if (!opts.ownerConfigured) {
      throw new HttpError(503, 'AUTH_NOT_CONFIGURED', '尚未配置访问令牌（CORE_OWNER_TOKEN），暂时不能使用');
    }
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    const principal = m ? await opts.verify(m[1] as string) : null;
    if (!principal) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
    req.principal = principal;
    req.audit = bindAudit(opts.auditLog, actorOf(principal));
  });
}

/** 路由级权限：白名单式，默认拒绝；拒绝也写审计（result=denied）。 */
export function requireCapability(cap: Capability): preHandlerAsyncHookHandler {
  return async function (this: FastifyInstance, req: FastifyRequest, _reply: FastifyReply) {
    const p = req.principal;
    if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
    if (!principalCan(p, cap)) {
      await req.audit(`auth.denied`, { type: 'capability', id: cap }, 'denied', `${req.method} ${req.routeOptions.url ?? ''}`);
      throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
    }
  };
}

/** P0 单用户：只允许主人。 */
export const requireOwner: preHandlerAsyncHookHandler = async function (req: FastifyRequest) {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  if (p.type !== 'owner') {
    await req.audit('auth.denied', { type: 'role', id: 'owner' }, 'denied', `${req.method} ${req.routeOptions.url ?? ''}`);
    throw new HttpError(403, 'FORBIDDEN', '只有主人可以执行这个操作');
  }
};
