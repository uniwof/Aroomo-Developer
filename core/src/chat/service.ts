/**
 * 对话入口（PRODUCT 16.1「填入一个 Key 后能和模型对话」；D31 讨论模式；SEQUENCES.md「发一句话」；提议 H5）。
 *
 * LobeHub 的 OpenAI 兼容服务商指向 Core 的 /v1（模型名 `aroomo`）。Core 只做「交给谁」：
 *   - 输入里有 @成员 → 点名：被点名的成员直接回答（多人各自回答，按顺序分段显示，P0 没有并排）；
 *   - 没有 @ → 交给负责人（P0 单人完成）；
 *   - 被点名成员出错 → 不自动换人，只回一行提示（D31）。
 * 真正调用模型的是 LiteLLM（D55、D70：Core 不碰供应商 Key、不做重试 / 回退 / 负载均衡）：Core 把请求原样转给
 * LiteLLM，只把 `model` 换成成员在 LiteLLM 里的模型名，把最后一条用户消息里的 @成员 去掉。
 * 其他模型名（LobeHub 的系统任务，例如起标题、翻译）直接交给负责人，不加任何提示和署名。
 */
import { randomUUID } from 'node:crypto';
import type { Member } from '../members/types.js';
import { route } from '../router/route.js';
import type { Hint, RoutableMember } from '../router/types.js';
import type { LeadService } from '../settings/lead.js';
import { activeMembers } from '../settings/lead.js';
import { looksSensitive, type SecurityService } from '../settings/security.js';

export const CHAT_MODEL = 'aroomo';
/** 负责人入口：有 @ 点名则该成员答，不 @ 由负责人答（与 aroomo 同义，给 LobeHub 群组里的负责人用） */
export const AUTO_MODEL = 'aroomo/auto';
/** 成员别名前缀：aroomo/<成员 id 或名字> 直接由该成员回答（LobeHub 群组里每个成员智能体用） */
export const MEMBER_MODEL_PREFIX = 'aroomo/';

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

/** 把 aroomo/<x> 解析成在职成员：先按 id，再按名字 / 别名（空格换成 -，大小写不敏感）。 */
export function resolveMemberModel(model: string, members: Member[]): Member | null {
  if (!model.startsWith(MEMBER_MODEL_PREFIX) || model === AUTO_MODEL) return null;
  const key = slug(model.slice(MEMBER_MODEL_PREFIX.length));
  if (!key) return null;
  return members.find((m) => m.id === key) ?? members.find((m) => [m.name, ...m.aliases].some((n) => slug(n) === key)) ?? null;
}
export const MEMBER_TIMEOUT_MS = 120_000;

export interface ChatDeps {
  litellmBaseUrl: string;
  litellmKey: string | undefined;
  listMembers: () => Promise<Member[]>;
  lead: LeadService;
  /** 敏感内容保护开关（D38）；不传 = 开 */
  security?: SecurityService;
  /** 账号成员的上游模型名映射（如 u<hex>/名字）；不传 = 原名（所有者共享池） */
  upstreamModel?: (name: string) => string;
  /** 规矩（公共记忆 topic rules）：对话转发前拼进系统提示；不传或返回 null = 不注入 */
  rules?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export const RULES_MAX = 4000;

/** 把规矩放进消息列表最前面的系统消息（已有的系统提示保留，规矩在它前面） */
export function withRules(messages: ChatMessage[], rules: string | null): ChatMessage[] {
  const r = rules?.trim();
  if (!r) return messages;
  return [{ role: 'system', content: `【Aroomo 规矩】请遵守下面的规矩：\n${r.slice(0, RULES_MAX)}` }, ...messages];
}

export const NO_LEAD_TEXT =
  '还没有合格的负责人（要能文字对话、上下文 ≥32k、支持工具调用）。可以用「@成员名」直接点名，或在「成员」里让一个合格的模型入职。';

type Json = Record<string, unknown>;
interface ChatMessage {
  role: string;
  content: unknown;
  [k: string]: unknown;
}

export interface ChatResult {
  status: number;
  headers: Record<string, string>;
  /** 流式时是一个可读流；否则是 JSON */
  stream?: ReadableStream<Uint8Array>;
  json?: unknown;
}

const enc = new TextEncoder();

/** 取最后一条用户消息的文字（content 可能是字符串或多段数组） */
export function lastUserText(messages: ChatMessage[]): { index: number; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { index: i, text: m.content };
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((p): p is { type: string; text: string } => typeof p === 'object' && p !== null && (p as Json).type === 'text')
        .map((p) => p.text)
        .join('\n');
      return { index: i, text };
    }
    return { index: i, text: '' };
  }
  return null;
}

/** 把最后一条用户消息的文字换成去掉 @ 的正文（图片等其他部分保留） */
export function replaceUserText(messages: ChatMessage[], index: number, body: string): ChatMessage[] {
  return messages.map((m, i) => {
    if (i !== index) return m;
    if (Array.isArray(m.content)) {
      let done = false;
      const parts = (m.content as Json[]).flatMap((p) => {
        if (p.type !== 'text') return [p];
        if (done) return [];
        done = true;
        return [{ ...p, text: body }];
      });
      return { ...m, content: parts };
    }
    return { ...m, content: body };
  });
}

function chunk(model: string, content: string, finish: string | null = null): Uint8Array {
  const obj = {
    id: `aroomo-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: finish ? {} : { role: 'assistant', content }, finish_reason: finish }],
  };
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function completion(model: string, content: string): Json {
  return {
    id: `aroomo-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 直接回一段文字（流式或非流式），用于提示类回答 */
function textReply(stream: boolean, text: string): ChatResult {
  if (!stream) return { status: 200, headers: { 'content-type': 'application/json' }, json: completion(CHAT_MODEL, text) };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(chunk(CHAT_MODEL, text));
      c.enqueue(chunk(CHAT_MODEL, '', 'stop'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return { status: 200, headers: sseHeaders(), stream: body };
}

const sseHeaders = () => ({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });

const hintText = (hints: Hint[]) => hints.map((h) => `> ${h.text}${h.actions.length ? '（去掉 @ 再发一次即可交给负责人）' : ''}`).join('\n');

export class ChatService {
  readonly #fetch: typeof fetch;
  constructor(private readonly d: ChatDeps) {
    this.#fetch = d.fetchImpl ?? fetch;
  }

  /** 模型列表：aroomo、aroomo/auto（负责人入口），以及每位在职成员的别名 aroomo/<id> */
  async models(): Promise<Json> {
    const members = activeMembers(await this.d.listMembers());
    const ids = [CHAT_MODEL, AUTO_MODEL, ...members.map((m) => `${MEMBER_MODEL_PREFIX}${m.id}`)];
    return { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'aroomo' })) };
  }

  async #rules(): Promise<string | null> {
    try {
      return (await this.d.rules?.()) ?? null;
    } catch {
      return null; // 规矩读不到不影响对话
    }
  }

  async #upstream(body: Json, signal: AbortSignal): Promise<Response> {
    if (!this.d.litellmKey) throw new Error('litellm_not_configured');
    return this.#fetch(`${this.d.litellmBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.d.litellmKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.d.upstreamModel && typeof body.model === 'string' ? { ...body, model: this.d.upstreamModel(body.model) } : body),
      signal,
    });
  }

  /** 按调用者的上下文（成员名前缀映射/成员列表）处理一次对话；不传 ctx = 用全局依赖 */
  async complete(req: Json, signal: AbortSignal, ctx?: Pick<ChatDeps, 'upstreamModel' | 'listMembers' | 'rules'>): Promise<ChatResult> {
    if (ctx) return new ChatService({ ...this.d, ...ctx, fetchImpl: this.#fetch }).complete(req, signal);
    const stream = req.stream === true;
    const messages = (Array.isArray(req.messages) ? req.messages : []) as ChatMessage[];
    const decorated = req.model === CHAT_MODEL || req.model === AUTO_MODEL;
    const members = activeMembers(await this.d.listMembers());
    const routable: RoutableMember[] = members.map((m) => ({ id: m.id, name: m.name, aliases: m.aliases, enabled: m.enabled }));
    const leadState = await this.d.lead.get();
    const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? null;

    if (!members.length) {
      return textReply(stream, '还没有可用的成员。请先打开「成员 → Key 与接入」填入一个 Key，再在「成员」里点「入职」，就能对话了。');
    }

    // 成员别名 aroomo/<成员>：LobeHub 群组里该成员智能体的发言，直接由该成员回答（不解析 @、不加署名）
    if (typeof req.model === 'string' && req.model.startsWith(MEMBER_MODEL_PREFIX) && req.model !== AUTO_MODEL) {
      const target = resolveMemberModel(req.model, members);
      if (!target) return textReply(stream, `没有这位在职成员（${req.model}）。请在「成员」里确认名字，或改用 aroomo/auto 交给负责人。`);
      return this.#forward({ ...req, messages: withRules(messages, await this.#rules()) }, target.name, '', '', stream, signal);
    }

    // 系统任务（起标题、翻译等）：交给负责人，不解析 @、不加提示和署名。
    // 还没有合格负责人时，用第一个在职成员做这类内部小任务（不以「负责人」身份出现在对话里）。
    const last = lastUserText(messages);
    if (!decorated || !last) {
      return this.#forward(req, nameOf(leadState.effectiveLeadId) ?? members[0]!.name, '', '', stream, signal);
    }

    const protect = this.d.security ? (await this.d.security.get()).sensitiveProtect : true;
    const sensitive = protect && looksSensitive(last.text);
    const plan = route(last.text, { members: routable, leadId: leadState.effectiveLeadId, sensitive });
    const prefix = plan.hints.length ? `${hintText(plan.hints)}\n\n` : '';
    const nextMessages = withRules(replaceUserText(messages, last.index, plan.body), await this.#rules());

    if (plan.mode === 'delegate') {
      const leadName = nameOf(plan.leadId);
      if (!leadName) return textReply(stream, prefix + NO_LEAD_TEXT);
      return this.#forward({ ...req, messages: nextMessages }, leadName, prefix, `\n\n— ${leadName}（负责人）`, stream, signal);
    }

    if (plan.targets.length === 0) return textReply(stream, prefix.trim());
    if (plan.targets.length === 1) {
      const name = nameOf(plan.targets[0]!)!;
      return this.#forward({ ...req, messages: nextMessages }, name, prefix, `\n\n— ${name}`, stream, signal, true);
    }

    // 多人点名：各自独立、并行回答，按点名顺序分段（P0；并排显示需要改 LobeHub 消息组件，见 H5）
    const answers = await Promise.all(
      plan.targets.map(async (id) => {
        const name = nameOf(id)!;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), MEMBER_TIMEOUT_MS);
        signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        try {
          const res = await this.#upstream({ ...req, model: name, stream: false, messages: nextMessages }, ctrl.signal);
          if (!res.ok) throw new Error(`upstream ${res.status}`);
          const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          return `### ${name}\n\n${j.choices?.[0]?.message?.content ?? ''}`;
        } catch {
          return `### ${name}\n\n> ${name} 暂时没有回应（不会自动换人）。`;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return textReply(stream, prefix + answers.join('\n\n'));
  }

  /** 转给 LiteLLM；流式时在开头插入提示、在 [DONE] 前插入署名 */
  async #forward(req: Json, model: string, prefix: string, footer: string, stream: boolean, signal: AbortSignal, mention = false): Promise<ChatResult> {
    let res: Response;
    try {
      res = await this.#upstream({ ...req, model }, signal);
    } catch {
      return textReply(stream, prefix + `${model} 暂时没有回应：模型网关连不上，请稍后再试。`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const why = res.status === 401 || res.status === 403 ? 'Key 无效或没有权限' : res.status === 429 ? '额度用完或请求太频繁' : `模型网关返回 ${res.status}`;
      return textReply(stream, prefix + `${model} 暂时没有回应（${why}）。${mention ? '不会自动换人；去掉 @ 再发一次即可交给负责人。' : '请到「成员 → Key 与接入」检查 Key。'}`);
    }
    if (!stream) {
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const msg = j.choices?.[0]?.message;
      if (msg && typeof msg.content === 'string') msg.content = prefix + msg.content + footer;
      return { status: 200, headers: { 'content-type': 'application/json' }, json: j };
    }
    const upstream = res.body;
    if (!upstream) return textReply(true, prefix + footer.trim());
    const reader = upstream.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sentPrefix = false;
    const out = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (!sentPrefix) {
          sentPrefix = true;
          if (prefix) c.enqueue(chunk(model, prefix));
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buf.trim()) c.enqueue(enc.encode(buf.endsWith('\n\n') ? buf : buf + '\n\n'));
          c.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, i + 2);
          buf = buf.slice(i + 2);
          if (/^data:\s*\[DONE\]/m.test(event) && footer) c.enqueue(chunk(model, footer));
          c.enqueue(enc.encode(event));
        }
      },
      cancel() {
        void reader.cancel().catch(() => undefined);
      },
    });
    return { status: 200, headers: sseHeaders(), stream: out };
  }
}
