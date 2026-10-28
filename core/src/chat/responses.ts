/**
 * OpenAI Responses API（/v1/responses）→ Core 对话入口的转换层。
 *
 * LobeHub 2.2.x 的 OpenAI 服务商在开启「联网 / 智能搜索」等情况下改走 Responses API（apiMode: 'responses'），
 * 而 Core 的路由（D31 点名 / 交给负责人、署名）建在 chat/completions 上。这里把 Responses 请求转成
 * chat/completions 请求交给 ChatService.complete，再把结果（流式或非流式）转回 Responses 格式。
 *
 * P0 范围：文字与图片输入、文字输出。内置工具（web_search 等）和函数工具不转发（P0 没有联网搜索；
 * 工具调用请走 chat/completions），已有的 function_call / function_call_output 历史按 chat 格式还原。
 */
import { randomUUID } from 'node:crypto';
import type { ChatResult } from './service.js';

type Json = Record<string, unknown>;
const enc = new TextEncoder();

function partsToChat(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: Json[] = [];
  for (const p of content as Json[]) {
    if (!p || typeof p !== 'object') continue;
    if ((p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text });
    } else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : ((p.image_url as Json | undefined)?.url as string | undefined);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.length && parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}

/** Responses 请求体 → chat/completions 请求体 */
export function responsesToChat(req: Json): Json {
  const messages: Json[] = [];
  if (typeof req.instructions === 'string' && req.instructions) messages.push({ role: 'system', content: req.instructions });
  const input = req.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const it of input as Json[]) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: String(it.call_id ?? it.id ?? randomUUID()), type: 'function', function: { name: String(it.name ?? ''), arguments: String(it.arguments ?? '{}') } }],
        });
        continue;
      }
      if (it.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: String(it.call_id ?? ''), content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? '') });
        continue;
      }
      if (typeof it.role === 'string' && (it.type === undefined || it.type === 'message')) {
        const role = it.role === 'developer' ? 'system' : it.role;
        messages.push({ role, content: partsToChat(it.content) });
      }
      // reasoning 等其他条目：P0 忽略
    }
  }
  const out: Json = { model: req.model, messages, stream: req.stream === true };
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (typeof req.max_output_tokens === 'number') out.max_tokens = req.max_output_tokens;
  return out;
}

function responseObject(id: string, model: string, text: string, status = 'completed'): Json {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    error: null,
    incomplete_details: null,
    output: [{ id: `msg_${id}`, type: 'message', role: 'assistant', status, content: [{ type: 'output_text', text, annotations: [] }] }],
    output_text: text,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

const ev = (type: string, extra: Json) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);

/** chat/completions 的结果 → Responses 的结果 */
export function chatToResponses(res: ChatResult, model: string): ChatResult {
  const id = `resp_${randomUUID().replace(/-/g, '')}`;
  const itemId = `msg_${id}`;
  if (!res.stream) {
    const j = (res.json ?? {}) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = j.choices?.[0]?.message?.content;
    return { status: res.status, headers: { 'content-type': 'application/json' }, json: responseObject(id, model, typeof c === 'string' ? c : '') };
  }
  const reader = res.stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let started = false;
  let finished = false;
  let usage: Json | undefined;
  const handleEvent = (event: string, c: ReadableStreamDefaultController<Uint8Array>) => {
    for (const line of event.split('\n')) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      const data = m[1]!.trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
        const d = j.choices?.[0]?.delta?.content;
        if (typeof d === 'string' && d) {
          text += d;
          c.enqueue(ev('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: d }));
        }
        if (j.usage) {
          usage = { input_tokens: j.usage.prompt_tokens ?? 0, output_tokens: j.usage.completion_tokens ?? 0, total_tokens: j.usage.total_tokens ?? 0 };
        }
      } catch {
        // 不是 JSON 的行：忽略
      }
    }
  };
  const finish = (c: ReadableStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    c.enqueue(ev('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text }));
    c.enqueue(ev('response.output_item.done', { output_index: 0, item }));
    const resp = responseObject(id, model, text);
    if (usage) resp.usage = usage;
    c.enqueue(ev('response.completed', { response: resp }));
    c.close();
  };
  const out = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!started) {
        started = true;
        c.enqueue(ev('response.created', { response: { ...responseObject(id, model, '', 'in_progress'), output: [] } }));
        c.enqueue(ev('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }));
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        if (buf.trim()) handleEvent(buf, c);
        buf = '';
        finish(c);
        return;
      }
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handleEvent(event, c);
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
  return { status: 200, headers: res.headers, stream: out };
}
