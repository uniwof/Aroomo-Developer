/**
 * 控制台原生对话入口 POST /api/chat/stream（#250 原生聊天 spike，S0；只在 spike/native-chat 分支）。
 *
 * - 鉴权：只认控制台会话 Cookie（aroomo_session，账号会话）+ X-Aroomo-Request 防 CSRF 头；
 *   带 Authorization 头的请求一律拒绝（这个入口只给浏览器控制台用，令牌走 /v1）。
 *   CORE_CHAT_TOKEN / LiteLLM Key 永远不进浏览器：浏览器只拿到纯文字增量。
 * - 不能冒充：userId 只从会话里取，请求体里的任何 user / userId 字段一律忽略。
 * - 路由与署名：直接复用 ChatService.complete(…, ctxFor(userId))，D31 点名 / 负责人 / 署名零改动。
 * - 输出：Vercel AI SDK UI Message Stream 协议（SSE；start / text-start / text-delta / text-end / finish / [DONE]，
 *   出错发 error；响应头 x-vercel-ai-ui-message-stream: v1）。assistant-ui 和 AI SDK useChat 都能直接接。
 * - 中断：浏览器断开（点「停止」= abort fetch）→ 取消上游请求（AbortSignal 透传到 LiteLLM 的 fetch）。
 * - 限制：请求体 ≤256KB；每个账号每分钟 ≤20 次、同时 ≤2 条流（内存态，单实例足够 spike）。
 * - 不落库（S1 再加 conversations / messages 表 + RLS）。
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CSRF_HEADER, readSessionCookie } from '../auth/session-cookie.js';
import { HttpError } from '../http/errors.js';
import { CHAT_MODEL, MEMBER_MODEL_PREFIX, type ChatService, type ChatUserCtx } from './service.js';

export const STREAM_BODY_LIMIT = 256 * 1024;
export const STREAM_MAX_MESSAGES = 200;
export const STREAM_MAX_TEXT = 32_000;
export const UI_STREAM_HEADER = 'x-vercel-ai-ui-message-stream';

export interface StreamLimits {
  /** 每个账号每分钟最多几次（默认 20） */
  perMinute: number;
  /** 每个账号同时最多几条流（默认 2） */
  concurrent: number;
}

/** 每个账号的频率 / 并发限制（内存态） */
export class UserRateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #open = new Map<string, number>();
  constructor(
    private readonly limits: StreamLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** 允许则占一个并发名额并返回释放函数；不允许返回 null */
  acquire(userId: string): (() => void) | null {
    const t = this.now();
    const hits = (this.#hits.get(userId) ?? []).filter((x) => t - x < 60_000);
    const open = this.#open.get(userId) ?? 0;
    if (hits.length >= this.limits.perMinute || open >= this.limits.concurrent) {
      this.#hits.set(userId, hits);
      return null;
    }
    hits.push(t);
    this.#hits.set(userId, hits);
    this.#open.set(userId, open + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.#open.get(userId) ?? 1) - 1;
      if (n <= 0) this.#open.delete(userId);
      else this.#open.set(userId, n);
    };
  }
}

type Json = Record<string, unknown>;
interface InMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 浏览器发来的消息 → chat/completions 的 messages。
 * 接受两种写法：{ role, content: string }，或 AI SDK useChat 的 { role, parts: [{ type: 'text', text }] }。
 * 只允许 user / assistant 角色（system 由 Core 自己拼：规矩等），只取文字（S0 不传图片和文件）。
 */
export function normalizeMessages(raw: unknown): InMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'BAD_REQUEST', '没有消息');
  if (raw.length > STREAM_MAX_MESSAGES) throw new HttpError(400, 'BAD_REQUEST', '消息太多了');
  const out: InMessage[] = [];
  for (const m of raw as Json[]) {
    if (!m || typeof m !== 'object') throw new HttpError(400, 'BAD_REQUEST', '消息格式不对');
    if (m.role !== 'user' && m.role !== 'assistant') throw new HttpError(400, 'BAD_REQUEST', '消息角色只能是 user 或 assistant');
    let text: string;
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.parts)) {
      text = (m.parts as Json[])
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n');
    } else throw new HttpError(400, 'BAD_REQUEST', '消息格式不对');
    if (text.length > STREAM_MAX_TEXT) throw new HttpError(400, 'BAD_REQUEST', '一条消息太长了');
    out.push({ role: m.role, content: text });
  }
  if (out[out.length - 1]!.role !== 'user') throw new HttpError(400, 'BAD_REQUEST', '最后一条必须是你说的话');
  return out;
}

/** 模型名只能是 aroomo（交给负责人 / @点名）或 aroomo/<成员>；不给 = aroomo */
export function normalizeModel(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return CHAT_MODEL;
  if (typeof raw !== 'string' || raw.length > 120) throw new HttpError(400, 'BAD_REQUEST', '模型名不对');
  if (raw === CHAT_MODEL || (raw.startsWith(MEMBER_MODEL_PREFIX) && raw.length > MEMBER_MODEL_PREFIX.length)) return raw;
  throw new HttpError(400, 'BAD_REQUEST', '模型名不对');
}

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
export const GENERIC_ERROR_TEXT = '对话出错了，请稍后再试。';

/**
 * OpenAI chat.completion.chunk SSE 流 → AI SDK UI Message Stream。
 * 只转发文字增量；上游的 error 对象不透传原文（可能带 Key），统一换成一句话。
 */
export function toUiMessageStream(upstream: ReadableStream<Uint8Array> | undefined, opts: { messageId?: string; onDone?: () => void } = {}): ReadableStream<Uint8Array> {
  const messageId = opts.messageId ?? `msg_${randomUUID()}`;
  const textId = `txt_${randomUUID()}`;
  const reader = upstream?.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let started = false;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    opts.onDone?.();
  };
  const finish = (c: ReadableStreamDefaultController<Uint8Array>, error?: string) => {
    if (error) c.enqueue(sse({ type: 'error', errorText: error }));
    else {
      c.enqueue(sse({ type: 'text-end', id: textId }));
      c.enqueue(sse({ type: 'finish-step' }));
      c.enqueue(sse({ type: 'finish' }));
    }
    c.enqueue(enc.encode('data: [DONE]\n\n'));
    c.close();
    done();
  };
  /** 处理一个 SSE 事件；返回 'done' = 上游结束，string = 出错，null = 继续 */
  const handle = (c: ReadableStreamDefaultController<Uint8Array>, event: string): 'done' | { error: string } | null => {
    for (const line of event.split('\n')) {
      const m = /^data:\s?(.*)$/.exec(line.trimEnd());
      if (!m) continue;
      const data = m[1]!.trim();
      if (data === '[DONE]') return 'done';
      let j: Json;
      try {
        j = JSON.parse(data) as Json;
      } catch {
        continue;
      }
      if (j.error) return { error: GENERIC_ERROR_TEXT };
      const choices = Array.isArray(j.choices) ? (j.choices as Json[]) : [];
      for (const ch of choices) {
        const delta = ch.delta as Json | undefined;
        const piece = typeof delta?.content === 'string' ? delta.content : '';
        if (piece) c.enqueue(sse({ type: 'text-delta', id: textId, delta: piece }));
      }
    }
    return null;
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!started) {
        started = true;
        c.enqueue(sse({ type: 'start', messageId }));
        c.enqueue(sse({ type: 'start-step' }));
        c.enqueue(sse({ type: 'text-start', id: textId }));
        if (!reader) return finish(c);
        return;
      }
      if (!reader) return finish(c);
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) {
            if (buf.trim()) {
              const r = handle(c, buf);
              buf = '';
              if (r && r !== 'done') return finish(c, r.error);
            }
            return finish(c);
          }
          buf += dec.decode(value, { stream: true });
          let emitted = false;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const event = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const r = handle(c, event);
            if (r === 'done') {
              void reader.cancel().catch(() => undefined);
              return finish(c);
            }
            if (r) {
              void reader.cancel().catch(() => undefined);
              return finish(c, r.error);
            }
            emitted = true;
          }
          if (emitted) return;
        }
      } catch {
        // 上游断了（或被中断）：给浏览器一句话，不带原文
        if (!finished) finish(c, GENERIC_ERROR_TEXT);
      }
    },
    cancel() {
      void reader?.cancel().catch(() => undefined);
      done();
    },
  });
}

export interface ChatStreamOptions {
  ctxFor: (userId: string) => ChatUserCtx;
  limits?: { perMinute?: number; concurrent?: number };
  now?: () => number;
}

/** 只认控制台会话：没有 Cookie / 带了 Authorization / 不是账号 / 没有 CSRF 头 → 拒绝；返回会话里的 userId */
function sessionUser(req: FastifyRequest): string {
  if (req.headers.authorization) throw new HttpError(401, 'SESSION_REQUIRED', '请从控制台登录后再对话');
  if (!readSessionCookie(req.headers.cookie)) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  const p = req.principal;
  if (!p || p.type !== 'user') throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  // 认证钩子已经对 Cookie + POST 检查过 CSRF 头；这里再查一次，防止以后钩子改动漏掉
  if (!req.headers[CSRF_HEADER]) throw new HttpError(403, 'CSRF', `用 Cookie 登录时，改动类请求要带 ${CSRF_HEADER} 头`);
  return p.userId;
}

export function registerChatStreamRoute(app: FastifyInstance, chat: ChatService, opts: ChatStreamOptions): void {
  const limiter = new UserRateLimiter({ perMinute: opts.limits?.perMinute ?? 20, concurrent: opts.limits?.concurrent ?? 2 }, opts.now);

  app.post<{ Body: Json }>(
    '/api/chat/stream',
    {
      // D208：每条 /api 路由都要声明权限。对话会动用成员（消耗它们的额度），按「只有主人能用的普通能力」members:write 声明，
      // 不在操作员白名单里（操作员令牌在钩子就被拒）。真正的门是处理函数里的 sessionUser：只认账号的 Cookie 会话 + CSRF 头，
      // 所有者令牌 / 操作员 / 客户端令牌（都走 Bearer）一律 401。账号可以访问（userRoute），数据只按会话里的 userId 取（D111）。
      // 能力名选得是否合适请负责人在 A+ 审查时定。
      config: { capability: 'members:write', userRoute: true },
      bodyLimit: STREAM_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['messages'],
          properties: { messages: { type: 'array', minItems: 1, maxItems: STREAM_MAX_MESSAGES }, model: { type: 'string', maxLength: 120 } },
        },
      },
    },
    async (req, reply) => {
      const userId = sessionUser(req);
      const messages = normalizeMessages(req.body.messages);
      const model = normalizeModel(req.body.model);
      const release = limiter.acquire(userId);
      if (!release) {
        await req.audit('auth.denied', { type: 'rate', id: '/api/chat/stream' }, 'denied', '对话请求太频繁');
        throw new HttpError(429, 'RATE_LIMITED', '说得太快了，请稍等一下再发');
      }
      const ctrl = new AbortController();
      // 浏览器断开（点停止）→ 中断上游。用响应的 close：请求体读完后 req 的 close 也会触发，不能用
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) ctrl.abort();
        release();
      });
      let body: ReadableStream<Uint8Array>;
      try {
        const out = await chat.complete({ model, stream: true, messages }, ctrl.signal, opts.ctxFor(userId));
        if (out.stream) body = toUiMessageStream(out.stream, { onDone: release });
        else {
          // 理论上 stream:true 总是返回流；万一是 JSON，就把文字一次性发出去
          const text = (out.json as { choices?: Array<{ message?: { content?: unknown } }> } | undefined)?.choices?.[0]?.message?.content;
          body = toUiMessageStream(oneShot(typeof text === 'string' ? text : ''), { onDone: release });
        }
      } catch {
        body = errorStream(GENERIC_ERROR_TEXT);
        release();
      }
      reply
        .code(200)
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('x-accel-buffering', 'no')
        .header(UI_STREAM_HEADER, 'v1');
      return reply.send(Readable.fromWeb(body as import('node:stream/web').ReadableStream));
    },
  );
}

function oneShot(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(sse({ choices: [{ index: 0, delta: { content: text } }] }));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

function errorStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(sse({ type: 'start', messageId: `msg_${randomUUID()}` }));
      c.enqueue(sse({ type: 'error', errorText: text }));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}
