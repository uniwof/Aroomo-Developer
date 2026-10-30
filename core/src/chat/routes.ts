/**
 * OpenAI 兼容的对话入口 /v1/*（只给 LobeHub 用；只在容器网络内可达）。
 * 鉴权：Authorization: Bearer <CORE_CHAT_TOKEN>（与主人令牌分开：泄露也只能对话，不能管理成员 / Key）。
 */
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../http/errors.js';
import { chatToResponses, responsesToChat } from './responses.js';
import type { ChatService } from './service.js';

function tokenOk(req: FastifyRequest, expected: string | undefined): void {
  if (!expected) throw new HttpError(503, 'CHAT_NOT_CONFIGURED', '对话入口还没有配置（缺少 CORE_CHAT_TOKEN）');
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  const a = Buffer.from(m?.[1] ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'UNAUTHORIZED', '对话令牌不对');
}

export function registerChatRoutes(app: FastifyInstance, chat: ChatService, chatToken: string | undefined): void {
  app.get('/v1/models', async (req) => {
    tokenOk(req, chatToken);
    return await chat.models();
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
      tokenOk(req, chatToken);
      const ctrl = new AbortController();
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) ctrl.abort();
      });
      const out = await chat.complete(req.body, ctrl.signal);
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
      tokenOk(req, chatToken);
      const ctrl = new AbortController();
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) ctrl.abort();
      });
      const model = typeof req.body.model === 'string' ? req.body.model : 'aroomo';
      const out = chatToResponses(await chat.complete(responsesToChat(req.body), ctrl.signal), model);
      reply.code(out.status).headers(out.headers);
      if (out.stream) return reply.send(Readable.fromWeb(out.stream as import('node:stream/web').ReadableStream));
      return reply.send(out.json);
    },
  );
}
