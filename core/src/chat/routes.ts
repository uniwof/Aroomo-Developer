/**
 * OpenAI 兼容的对话入口 /v1/*（只给 LobeHub 用；只在容器网络内可达）。
 * 鉴权：Authorization: Bearer <CORE_CHAT_TOKEN>（与主人令牌分开：泄露也只能对话，不能管理成员 / Key）。
 */
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../http/errors.js';
import { chatToResponses, responsesToChat } from './responses.js';
import type { ChatService, ChatUserCtx } from './service.js';

function bearerOf(req: FastifyRequest): string {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m?.[1] ?? '';
}

function tokenOk(req: FastifyRequest, expected: string | undefined): void {
  if (!expected) throw new HttpError(503, 'CHAT_NOT_CONFIGURED', '对话入口还没有配置（缺少 CORE_CHAT_TOKEN）');
  const a = Buffer.from(bearerOf(req));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'UNAUTHORIZED', '对话令牌不对');
}

/** 账号路由：客户端令牌（带 models:chat 范围）→ 令牌主人；ctxFor 给出该账号自己的成员 / 负责人 / 规矩 / 上游前缀 */
export interface ChatUserRouting {
  /** 返回令牌主人的 userId（'owner' 或账号 id）；不是有效的 models:chat 令牌返回 null */
  verify: (token: string) => Promise<string | null>;
  ctxFor: (userId: string) => ChatUserCtx;
}

/**
 * 认出调用者：CORE_CHAT_TOKEN = 所有者（LobeHub 用）；带 models:chat 的客户端令牌 = 令牌主人。
 * 其余一律 401（同一句话，不区分「没有这个令牌」和「令牌没权限」）。
 * 返回 undefined = 所有者路径（全局依赖）；返回 ctx = 该账号自己的数据。
 */
async function callerCtx(req: FastifyRequest, expected: string | undefined, routing: ChatUserRouting | undefined): Promise<ChatUserCtx | undefined> {
  const token = bearerOf(req);
  if (expected && token.length === expected.length) {
    try {
      tokenOk(req, expected);
      return undefined;
    } catch {
      /* 不是所有者令牌，再试客户端令牌 */
    }
  }
  const uid = routing && token ? await routing.verify(token) : null;
  if (uid === null || !routing) {
    if (!expected) tokenOk(req, expected); // 没配置所有者对话令牌且不是有效客户端令牌：503（保持原行为）
    throw new HttpError(401, 'UNAUTHORIZED', '对话令牌不对');
  }
  return uid === 'owner' ? undefined : routing.ctxFor(uid);
}

export function registerChatRoutes(app: FastifyInstance, chat: ChatService, chatToken: string | undefined, routing?: ChatUserRouting): void {
  app.get('/v1/models', async (req) => {
    return await chat.models(await callerCtx(req, chatToken, routing));
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/v1/chat/completions',
    {
      // 图片以 base64 内嵌时请求体会很大
      bodyLimit: 32 * 1024 * 1024,
      schema: {
        body: { type: 'object', required: ['messages'], properties: { messages: { type: 'array', maxItems: 2000 }, model: { type: 'string', maxLength: 200 } } },
      },
    },
    async (req, reply) => {
      const ctx = await callerCtx(req, chatToken, routing);
      const ctrl = new AbortController();
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) ctrl.abort();
      });
      const out = await chat.complete(req.body, ctrl.signal, ctx);
      reply.code(out.status).headers(out.headers);
      if (out.stream) return reply.send(Readable.fromWeb(out.stream as import('node:stream/web').ReadableStream));
      return reply.send(out.json);
    },
  );

  // LobeHub 开启联网 / 智能搜索时走 Responses API：转成 chat/completions 走同一套路由，再转回来
  app.post<{ Body: Record<string, unknown> }>(
    '/v1/responses',
    {
      bodyLimit: 32 * 1024 * 1024,
      schema: { body: { type: 'object', properties: { model: { type: 'string', maxLength: 200 } } } },
    },
    async (req, reply) => {
      const ctx = await callerCtx(req, chatToken, routing);
      const ctrl = new AbortController();
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) ctrl.abort();
      });
      const model = typeof req.body.model === 'string' ? req.body.model : 'aroomo';
      const out = chatToResponses(await chat.complete(responsesToChat(req.body), ctrl.signal, ctx), model);
      reply.code(out.status).headers(out.headers);
      if (out.stream) return reply.send(Readable.fromWeb(out.stream as import('node:stream/web').ReadableStream));
      return reply.send(out.json);
    },
  );
}
