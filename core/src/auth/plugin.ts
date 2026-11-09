/**
 * /api/* 的鉴权：Bearer 令牌 → Principal；每个路由用 requireCapability 声明所需能力。
 * P0 单用户：requireOwner 即「主人令牌」（Issue #5 的占位钩子），后续接入登录态（PRODUCT §11.2 第 9 条）。
 */
import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler, preValidationAsyncHookHandler } from 'fastify';
import { bindAudit } from '../audit/common.js';
import type { AuditActor, AuditFn, AuditLog } from '../audit/types.js';
import { HttpError } from '../http/errors.js';
import type { Capability } from './capabilities.js';
import type { ConfirmCtx } from '../confirm/confirm.js';
import { actorKey, type Principal, principalCan } from './tokens.js';
import { CSRF_HEADER, readSessionCookie, UNSAFE_METHODS } from './session-cookie.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 这个接口需要的能力（D62：操作员只能调用声明了白名单能力的接口） */
    capability?: Capability;
    /** 账号（多用户）可以访问这个接口。没声明的接口账号一律 403（默认拒绝，直到该模块带 user_id 隔离） */
    userRoute?: boolean;
    /** 客户端令牌（B3）需要具备的范围；没声明的接口客户端一律 403 */
    clientScope?: string;
    /** /mcp：客户端令牌可以进入，具体工具的范围在 MCP 内逐个检查（没有范围的工具表现为不存在） */
    clientMcp?: boolean;
    /** 客户端可以查看自己（GET /api/clients/self） */
    clientSelf?: boolean;
  }
  interface FastifyRequest {
    principal: Principal | null;
    /** 已绑定当前操作者的审计回调 */
    audit: AuditFn;
  }
}

export function actorOf(p: Principal): AuditActor {
  if (p.type === 'owner') return { type: 'owner', id: 'owner' };
  if (p.type === 'client') return { type: 'client', id: p.clientId };
  return p.type === 'user' ? { type: 'user', id: p.userId } : { type: 'operator', id: p.id };
}

export interface AuthOptions {
  verify: (token: string) => Promise<Principal | null>;
  auditLog: AuditLog;
  /** 未配置主人令牌时，/api 一律 503（避免「无令牌也能用」的默认开放）。 */
  ownerConfigured: boolean;
  /** 每个凭据（没有凭据按 IP）每分钟最多请求数；默认 1200。防暴力猜令牌 / 刷接口（CodeQL js/missing-rate-limiting） */
  rateLimitPerMin?: number;
  /**
   * 必改 1 方案 A：所有者自己的账号 id（CORE_OWNER_ACCOUNT_ID）。是个函数：启动检查（server.ts onReady）通过后才返回 id；
   * 未设置 / 启动检查没过 = undefined = 不映射
   */
  ownerAccountId?: () => string | undefined;
}

/** 限速按凭据分桶：Shell 代理后所有请求同一个 IP，不能只按 IP；令牌只取摘要，不留原文 */
function limitKey(req: FastifyRequest): string {
  const cred = req.headers.authorization ?? readSessionCookie(req.headers.cookie);
  return cred ? `c:${createHash('sha256').update(cred).digest('base64url').slice(0, 22)}` : `ip:${req.ip}`;
}

const noAudit: AuditFn = async () => undefined;

/** 解码后的路径（去掉查询串）；解码失败返回 '/api/'，失败即关闭 */
function decodedPath(url: string): string {
  try {
    return decodeURIComponent(url.split('?')[0] ?? '');
  } catch {
    return '/api/';
  }
}

export function installAuth(app: FastifyInstance, opts: AuthOptions): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('audit', noAudit);
  // 限速（@fastify/rate-limit，MIT）：在下面验身份之前先计数，猜错的令牌也算；超出 → 429，错误格式与全站一致
  void app.register(rateLimit, {
    global: false,
    max: opts.rateLimitPerMin ?? 1200,
    timeWindow: 60_000,
    keyGenerator: limitKey,
    errorResponseBuilder: () => new HttpError(429, 'RATE_LIMITED', '请求太频繁，请稍后再试'),
  });
  let limit: ReturnType<FastifyInstance['rateLimit']> | undefined;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // 按匹配到的路由模式判断，不看原始 URL：/%61pi/keys 会被路由库解码后匹配到 /api/keys（#242 必改 1）
    // 没匹配到路由时，用解码后的路径判断（不存在的 /api/* 照样先验身份、操作员照样拒绝并审计；D62），解码失败按受保护处理
    const pattern = req.routeOptions.url ?? decodedPath(req.url);
    const isMcp = pattern === '/mcp';
    // /internal/* 也要验身份：LobeHub 的 SSRF 白名单放行 Core 整个 IP，不能有免验身份的接口（#235）
    if (!pattern.startsWith('/api/') && !pattern.startsWith('/internal/') && !isMcp) return;
    limit ??= app.rateLimit();
    await limit.call(app, req, reply);
    if (!opts.ownerConfigured) {
      throw new HttpError(503, 'AUTH_NOT_CONFIGURED', '尚未配置访问令牌（CORE_OWNER_TOKEN），暂时不能使用');
    }
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    // 没有 Bearer 头时，认控制台会话 Cookie（只对账号会话有效）
    const cookieToken = m ? null : readSessionCookie(req.headers.cookie);
    const raw = m ? (m[1] as string) : cookieToken;
    let principal = raw ? await opts.verify(raw) : null;
    if (!principal || (cookieToken && principal.type !== 'user')) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
    // 必改 1 方案 A：只认服务端配置（且启动检查通过）的账号 id，且这次请求时仍是管理员（verifySession 每次读库，停用即失效）；
    // 负责人必改 1：只对 Cookie 会话映射——同一个会话令牌放进 Bearer 头不映射（脚本 / 客户端拿到令牌也拿不到所有者范围）
    const ownerAccountId = opts.ownerAccountId?.();
    if (cookieToken && principal.type === 'user' && ownerAccountId && principal.userId === ownerAccountId && principal.role === 'admin') {
      principal = { ...principal, ownerAccount: true };
    }
    req.principal = principal;
    // 负责人必改 2：映射后的审计写明 scope=owner(mapped) 和账号 id（操作者仍记为这个账号）
    req.audit = principal.type === 'user' && principal.ownerAccount
      ? bindAudit(opts.auditLog, actorOf(principal), `scope=owner(mapped) account=${principal.userId}`)
      : bindAudit(opts.auditLog, actorOf(principal));
    if (cookieToken && UNSAFE_METHODS.has(req.method) && !req.headers[CSRF_HEADER]) {
      await req.audit('auth.denied', { type: 'csrf', id: req.routeOptions.url ?? req.url.split('?')[0] ?? '' }, 'denied', `${req.method} Cookie 会话缺少 ${CSRF_HEADER} 头`);
      throw new HttpError(403, 'CSRF', `用 Cookie 登录时，改动类请求要带 ${CSRF_HEADER} 头`);
    }
    // D62：操作员只按白名单放行。没有声明能力的接口、不存在的接口、白名单外的能力，一律拒绝并审计。
    if (principal.type === 'client') {
      const cfg = req.routeOptions.config;
      const ok = cfg?.clientSelf === true || cfg?.clientMcp === true || (cfg?.clientScope !== undefined && (principal.scopes as ReadonlySet<string>).has(cfg.clientScope));
      if (!ok) {
        await req.audit('auth.denied', { type: 'route', id: req.routeOptions.url ?? req.url.split('?')[0] ?? '' }, 'denied', `${req.method} 客户端令牌没有这个范围`);
        throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
      }
    }
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

/**
 * 数据归属：所有者令牌（及操作员，代表所有者）= 'owner'；账号 = 它自己的 id；
 * 所有者自己的账号（CORE_OWNER_ACCOUNT_ID，必改 1 方案 A）= 'owner'。所有业务查询都必须带它。
 */
export function scopeOf(req: FastifyRequest): string {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  if (p.type === 'client') return p.userId;
  if (p.type === 'user') return p.ownerAccount ? 'owner' : p.userId;
  return 'owner';
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

/**
 * 管理员检查：所有者令牌，或角色为 admin 的账号。挂在 preValidation（#349）：先 401/403 再校验请求体 / 参数，
 * 未授权的请求拿不到 schema 400（不泄露请求体形状，也不是存在性旁路），和 work / push / assistants 的惯例一致。
 */
export const requireAdmin: preValidationAsyncHookHandler = async function (req: FastifyRequest) {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  const isAdmin = p.type === 'owner' || (p.type === 'user' && p.role === 'admin');
  if (!isAdmin) {
    await req.audit('auth.denied', { type: 'role', id: 'admin' }, 'denied', `${req.method} ${req.routeOptions.url ?? ''}`);
    throw new HttpError(403, 'FORBIDDEN', '只有管理员可以执行这个操作');
  }
};

/** 管理员接口。用法：`{ ...adminGuard(), schema }`；不要再给同一路由另挂 preValidation（会覆盖掉这里的检查） */
export function adminGuard(): { config: { userRoute: true }; preValidation: preValidationAsyncHookHandler } {
  return { config: { userRoute: true }, preValidation: requireAdmin };
}
