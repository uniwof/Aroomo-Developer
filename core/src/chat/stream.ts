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
 * - 落库（会话存库）：请求带 conversationId 时，先确认是本账号的聊天会话（否则 404，和不存在一样），
 *   追加用户这句话（retry = true 时不追加：重试是同一句话再问一次），回复完整结束后追加回复（点了停止就存已收到的部分，出错不存）。
 *   只追加（X-21）；生成期间这个会话算「进行中」（X-27）。不带 conversationId = 不落库（旧前端、本机会话）。
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { scopeOf } from '../auth/plugin.js';
import { CSRF_HEADER, readSessionCookie } from '../auth/session-cookie.js';
import { HttpError } from '../http/errors.js';
import { CHAT_MODEL, MEMBER_MODEL_PREFIX, type ChatFailureCode, type ChatService, type ChatUserCtx } from './service.js';
import type { ConversationService } from '../conversations/service.js';

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

/**
 * 每个账号的频率 / 并发限制（内存态）：重启后清零。这是防刷，不是额度计数，单实例可以接受；
 * 多实例部署前要改成共享存储（负责人审查点 1 第 3 节第 6 条，D213 第 13 项）。
 */
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
 * 整条回复失败时浏览器看到的话（负责人审查点 1 补充裁决 1）：只从这几句固定的话里选，
 * 不带上游原文、状态码或任何别的内容。按失败码对应，不按回复文字判断。
 */
export const FAILURE_TEXT: Record<ChatFailureCode, string> = {
  gateway_unreachable: '模型网关连不上，请稍后重试。',
  key_invalid: 'Key 无效，请到「成员 → Key 与接入」检查。',
  rate_limited: '额度用完或太频繁，请稍后再试。',
  upstream_error: '模型出错了，请稍后重试。',
};
/** 失败码随 error 一起发给浏览器（AI SDK UI Message Stream 的 data-* 部件，transient = 不进消息历史），界面据此决定显示「重试」还是「去检查 Key」 */
export const FAILURE_PART = 'data-aroomo-failure';
const failureEvents = (code: ChatFailureCode) => [sse({ type: FAILURE_PART, data: { code }, transient: true }), sse({ type: 'error', errorText: FAILURE_TEXT[code] })];

/**
 * OpenAI chat.completion.chunk SSE 流 → AI SDK UI Message Stream。
 * 只转发文字增量；上游的 error 对象不透传原文（可能带 Key），统一换成一句话。
 */
export function toUiMessageStream(
  upstream: ReadableStream<Uint8Array> | undefined,
  opts: {
    messageId?: string;
    onDone?: () => void;
    /** 回复完整结束（不含出错）：拿到整段文字，等它做完才关流（落库） */
    onFinish?: (text: string) => Promise<void>;
    /** 浏览器断开（点停止）：拿到已收到的部分 */
    onCancel?: (text: string) => void;
  } = {},
): ReadableStream<Uint8Array> {
  const messageId = opts.messageId ?? `msg_${randomUUID()}`;
  const textId = `txt_${randomUUID()}`;
  const reader = upstream?.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let started = false;
  let finished = false;
  let wrote = false;
  let full = '';
  const done = () => {
    if (finished) return;
    finished = true;
    opts.onDone?.();
  };
  const finish = async (c: ReadableStreamDefaultController<Uint8Array>, error?: ChatFailureCode) => {
    if (finished) return;
    if (error) for (const e of failureEvents(error)) c.enqueue(e);
    else {
      await opts.onFinish?.(full).catch(() => undefined);
      c.enqueue(sse({ type: 'text-end', id: textId }));
      c.enqueue(sse({ type: 'finish-step' }));
      c.enqueue(sse({ type: 'finish' }));
    }
    c.enqueue(enc.encode('data: [DONE]\n\n'));
    c.close();
    done();
  };
  /** 处理一个 SSE 事件；返回 'done' = 上游结束，string = 出错，null = 继续 */
  const handle = (c: ReadableStreamDefaultController<Uint8Array>, event: string): 'done' | { error: ChatFailureCode } | null => {
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
      if (j.error) return { error: 'upstream_error' };
      const choices = Array.isArray(j.choices) ? (j.choices as Json[]) : [];
      for (const ch of choices) {
        const delta = ch.delta as Json | undefined;
        const piece = typeof delta?.content === 'string' ? delta.content : '';
        if (piece) { c.enqueue(sse({ type: 'text-delta', id: textId, delta: piece })); full += piece; wrote = true; }
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
        if (!reader) return await finish(c);
        return;
      }
      if (!reader) return await finish(c);
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) {
            if (buf.trim()) {
              const r = handle(c, buf);
              buf = '';
              if (r && r !== 'done') return await finish(c, r.error);
            }
            return await finish(c);
          }
          buf += dec.decode(value, { stream: true });
          wrote = false;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const event = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const r = handle(c, event);
            if (r === 'done') {
              void reader.cancel().catch(() => undefined);
              return await finish(c);
            }
            if (r) {
              void reader.cancel().catch(() => undefined);
              return await finish(c, r.error);
            }
          }
          if (wrote) return;
        }
      } catch {
        // 上游断了（或被中断）：给浏览器一句固定的话，不带原文
        if (!finished) await finish(c, 'gateway_unreachable');
      }
    },
    cancel() {
      void reader?.cancel().catch(() => undefined);
      if (!finished) opts.onCancel?.(full);
      done();
    },
  });
}

/** X-15：聊天里认出「每周一 9 点帮我…」时，负责人回一张助手草稿卡（只有所有者；规则判断，不调模型）。返回 null = 照常对话 */
export interface DraftReply {
  /** 负责人的名字（署名用） */
  lead: string;
  part: { type: string; data: unknown };
}
export const DRAFT_TEXT = '我拟了一个助手，你看看对不对。点「建好」才会真的建；想调整点「改一改」，不要就点「不用了」。';

export interface ChatStreamOptions {
  ctxFor: (userId: string) => ChatUserCtx;
  /** 只对所有者（scope = 'owner'）、交给负责人（model = aroomo）的最后一句话调用 */
  draftFor?: (text: string) => Promise<DraftReply | null>;
  limits?: { perMinute?: number; concurrent?: number };
  now?: () => number;
  /** 会话存库：给了才认请求里的 conversationId */
  conversations?: ConversationService;
}

/** 只认控制台会话：没有 Cookie / 带了 Authorization / 不是账号 / 没有 CSRF 头 → 拒绝；返回数据范围（scopeOf：账号 id，所有者自己的账号 = 'owner'） */
function sessionUser(req: FastifyRequest): string {
  if (req.headers.authorization) throw new HttpError(401, 'SESSION_REQUIRED', '请从控制台登录后再对话');
  if (!readSessionCookie(req.headers.cookie)) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  const p = req.principal;
  if (!p || p.type !== 'user') throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  // 认证钩子已经对 Cookie + POST 检查过 CSRF 头；这里再查一次，防止以后钩子改动漏掉
  if (!req.headers[CSRF_HEADER]) throw new HttpError(403, 'CSRF', `用 Cookie 登录时，改动类请求要带 ${CSRF_HEADER} 头`);
  return scopeOf(req);
}

export function registerChatStreamRoute(app: FastifyInstance, chat: ChatService, opts: ChatStreamOptions): void {
  const limiter = new UserRateLimiter({ perMinute: opts.limits?.perMinute ?? 20, concurrent: opts.limits?.concurrent ?? 2 }, opts.now);

  app.post<{ Body: Json }>(
    '/api/chat/stream',
    {
      // D208：每条 /api 路由都要声明权限。能力名 chat:use（负责人审查点 1 定名）：不在操作员白名单里（操作员令牌在钩子就被拒），
      // 也不是客户端令牌的范围。真正的门是处理函数里的 sessionUser：只认账号的 Cookie 会话 + CSRF 头，
      // 所有者令牌 / 操作员 / 客户端令牌（都走 Bearer）一律 401。账号可以访问（userRoute），数据只按会话里的 userId 取（D111）。
      config: { capability: 'chat:use', userRoute: true },
      bodyLimit: STREAM_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: { type: 'array', minItems: 1, maxItems: STREAM_MAX_MESSAGES },
            model: { type: 'string', maxLength: 120 },
            conversationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
            retry: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      // 'owner' = 所有者自己的账号（必改 1 方案 A）：走全局依赖（所有者的成员 / 负责人 / 规矩 / 敏感保护，用量照记）
      const scope = sessionUser(req);
      const messages = normalizeMessages(req.body.messages);
      const model = normalizeModel(req.body.model);
      // 会话存库：先确认是本账号的聊天会话（别人的 / 助手的 / 不存在的一律 404，同一句话），再占频率名额
      const convs = opts.conversations;
      const convId = convs && typeof req.body.conversationId === 'string' ? req.body.conversationId : null;
      if (convs && convId) await convs.get(scope, convId);
      const acquired = limiter.acquire(scope);
      if (!acquired) {
        await req.audit('auth.denied', { type: 'rate', id: '/api/chat/stream' }, 'denied', '对话请求太频繁');
        throw new HttpError(429, 'RATE_LIMITED', '说得太快了，请稍等一下再发');
      }
      const endRun = convs && convId ? convs.running.begin(scope, convId) : () => undefined;
      const release = () => {
        acquired();
        endRun();
      };
      const last = messages[messages.length - 1]!.content;
      /** 落库失败不打断对话（回复照样给浏览器），只记一行日志（不记内容） */
      const save = async (role: 'user' | 'assistant', text: string, meta: { draft: { id: string; data: unknown } } | null = null) => {
        if (!convs || !convId) return;
        await convs.append(scope, convId, role, text, meta).catch((err: Error) => req.log.error({ errName: err.name }, 'conversation append failed'));
      };
      if (req.body.retry !== true) await save('user', last);
      const ctrl = new AbortController();
      // 浏览器断开（点停止）→ 中断上游。用响应的 close：请求体读完后 req 的 close 也会触发，不能用
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) ctrl.abort();
        release();
      });
      let body: ReadableStream<Uint8Array>;
      // X-15：所有者在负责人对话里说「每周一 9 点帮我…」→ 不调模型，直接回草稿卡（家人账号、单独和成员的对话都不走这里）
      const draft = scope === 'owner' && model === CHAT_MODEL && opts.draftFor ? await opts.draftFor(last).catch(() => null) : null;
      if (draft) {
        const draftId = `draft_${randomUUID()}`;
        await save('assistant', draftText(draft), { draft: { id: draftId, data: draft.part.data } });
        body = draftStream(draft, draftId);
        release();
      } else {
        try {
          const out = await chat.complete({ model, stream: true, messages }, ctrl.signal, scope === 'owner' ? undefined : opts.ctxFor(scope));
          if (out.failure) {
            // 整条回复都失败：不发那段提示文字，改发 error（只有固定的一句话 + 失败码）。/v1 不走这里，行为不变
            await out.stream?.cancel().catch(() => undefined);
            body = errorStream(out.failure.code);
            release();
          } else if (out.stream) body = toUiMessageStream(out.stream, { onDone: release, onFinish: (t) => save('assistant', t), onCancel: (t) => void save('assistant', t) });
          else {
            // 理论上 stream:true 总是返回流；万一是 JSON，就把文字一次性发出去
            const text = (out.json as { choices?: Array<{ message?: { content?: unknown } }> } | undefined)?.choices?.[0]?.message?.content;
            body = toUiMessageStream(oneShot(typeof text === 'string' ? text : ''), { onDone: release, onFinish: (t) => save('assistant', t) });
          }
        } catch {
          body = errorStream('upstream_error');
          release();
        }
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

const draftText = (d: DraftReply) => `${DRAFT_TEXT}\n\n— ${d.lead}（负责人）`;

function draftStream(d: DraftReply, draftId: string): ReadableStream<Uint8Array> {
  const textId = `txt_${randomUUID()}`;
  return new ReadableStream({
    start(c) {
      c.enqueue(sse({ type: 'start', messageId: `msg_${randomUUID()}` }));
      c.enqueue(sse({ type: 'start-step' }));
      c.enqueue(sse({ type: 'text-start', id: textId }));
      c.enqueue(sse({ type: 'text-delta', id: textId, delta: draftText(d) }));
      c.enqueue(sse({ type: 'text-end', id: textId }));
      // 不是 transient：草稿卡跟着这条回复留在会话里；id 给「建好」当幂等键
      c.enqueue(sse({ type: d.part.type, id: draftId, data: d.part.data }));
      c.enqueue(sse({ type: 'finish-step' }));
      c.enqueue(sse({ type: 'finish' }));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

function errorStream(code: ChatFailureCode): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(sse({ type: 'start', messageId: `msg_${randomUUID()}` }));
      for (const e of failureEvents(code)) c.enqueue(e);
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}
