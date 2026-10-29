/**
 * /api/* 的鉴权：Bearer 令牌 → Principal；每个路由用 requireCapability 声明所需能力。
 * P0 单用户：requireOwner 即「主人令牌」（Issue #5 的占位钩子），后续接入登录态（PRODUCT §11.2 第 9 条）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { bindAudit } from '../audit/common.js';
import type { AuditActor, AuditFn, AuditLog } from '../audit/types.js';
import { HttpError } from '../http/errors.js';
import type { Capability } from './capabilities.js';
import type { ConfirmCtx } from '../confirm/confirm.js';
import { actorKey, type Principal, principalCan } from './tokens.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 这个接口需要的能力（D62：操作员只能调用声明了白名单能力的接口） */
    capability?: Capability;
    /** 账号（多用户）可以访问这个接口。没声明的接口账号一律 403（默认拒绝，直到该模块带 user_id 隔离） */
    userRoute?: boolean;
  }
  interface FastifyRequest {
    principal: Principal | null;
    /** 已绑定当前操作者的审计回调 */
    audit: AuditFn;
  }
}

export function actorOf(p: Principal): AuditActor {
  if (p.type === 'owner') return { type: 'owner', id: 'owner' };
  return p.type === 'user' ? { type: 'user', id: p.userId } : { type: 'operator', id: p.id };
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
    // D62：操作员只按白名单放行。没有声明能力的接口、不存在的接口、白名单外的能力，一律拒绝并审计。
    if (principal.type === 'user' && !req.routeOptions.config?.userRoute) {
      await req.audit('auth.denied', { type: 'route', id: req.routeOptions.url ?? req.url.split('?')[0] ?? '' }, 'denied', `${req.method} 账号不能访问这个接口`);
      throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
    }
    if (principal.type === 'operator') {
      const cap = req.routeOptions.config?.capability;
      if (!cap || !principalCan(principal, cap)) {
        await req.audit('auth.denied', { type: 'capability', id: cap ?? '(none)' }, 'denied', `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`);
        throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
      }
    }
  });
}

/** 路由选项：声明所需能力（供操作员白名单检查）并挂上 requireCapability。用法：`{ ...guard('members:read'), schema }` */
export function guard(cap: Capability): { config: { capability: Capability }; preHandler: preHandlerAsyncHookHandler };
/** `{ user: true }`：账号也能用，但处理函数必须按 `scopeOf(req)` 只读写本人的数据（D111）。 */
export function guard(cap: Capability, opts: { user: true }): { config: { capability: Capability; userRoute: true }; preHandler: preHandlerAsyncHookHandler };
export function guard(cap: Capability, opts?: { user?: boolean }) {
  if (!opts?.user) return { config: { capability: cap }, preHandler: requireCapability(cap) };
  const cheque = requireCapability(cap);
  return {
    config: { capability: cap, userRoute: true as const },
    preHandler: async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      if (req.principal?.type === 'user') return; // 账号：数据隔离由 scopeOf 保证，不走能力白名单
      return cheque.call(this, req, reply);
    } as preHandlerAsyncHookHandler,
  };
}

/** 数据归属：所有者令牌（及操作员，代表所有者）= 'owner'；账号 = 它自己的 id。所有业务查询都必须带它。 */
export function scopeOf(req: FastifyRequest): string {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  return p.type === 'user' ? p.userId : 'owner';
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

/** 统一确认服务需要的操作者上下文（D63）。重要确认只能由主人完成（confirm:important，D62）。 */
export function confirmCtx(p: Principal, confirmToken?: string): ConfirmCtx {
  return { actor: actorKey(p), canConfirmImportant: principalCan(p, 'confirm:important'), ...(confirmToken ? { confirmToken } : {}) };
}

/** 账号可用的接口（本人的数据）。用法：`{ ...userGuard(), schema }` */
export function userGuard(): { config: { userRoute: true }; preHandler: preHandlerAsyncHookHandler } {
  return {
    config: { userRoute: true },
    preHandler: async function (req: FastifyRequest) {
      if (!req.principal) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
    },
  };
}

/** 管理员：所有者令牌，或角色为 admin 的账号。 */
export function adminGuard(): { config: { userRoute: true }; preHandler: preHandlerAsyncHookHandler } {
  return {
    config: { userRoute: true },
    preHandler: async function (req: FastifyRequest) {
      const p = req.principal;
      if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
      const isAdmin = p.type === 'owner' || (p.type === 'user' && p.role === 'admin');
      if (!isAdmin) {
        await req.audit('auth.denied', { type: 'role', id: 'admin' }, 'denied', `${req.method} ${req.routeOptions.url ?? ''}`);
        throw new HttpError(403, 'FORBIDDEN', '只有管理员可以执行这个操作');
      }
    },
  };
}
