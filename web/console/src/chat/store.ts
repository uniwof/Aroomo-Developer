/**
 * 原生对话（#250 spike）：调用 Core 的 POST /api/chat/stream，读 AI SDK UI Message Stream（SSE）。
 * - 只靠控制台会话 Cookie（HttpOnly，脚本读不到）+ X-Aroomo-Request 头；从不发 Authorization，从不碰任何 Key。
 * - 会话列表和消息先存在本机浏览器 localStorage（S1 再落库）。
 */

import { PREFS_KEY, readDisplayPrefs, type Theme } from '@/lib/display';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface Conversation {
  id: string;
  title: string;
  /** 'aroomo' = 交给负责人（可 @ 点名）；'aroomo/<成员 id>' = 单独和这位成员对话 */
  model: string;
  /** 群聊：这些成员一起回答（没写 @ 时自动 @ 他们） */
  group?: string[];
  messages: ChatTurn[];
  updatedAt: number;
}

export const STREAM_URL = '/api/chat/stream';

/** 解析一段 SSE 文本里完整的事件；返回事件和剩下的半截 */
export function splitSse(buf: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let i: number;
  let rest = buf.replace(/\r\n/g, '\n');
  while ((i = rest.indexOf('\n\n')) >= 0) {
    events.push(rest.slice(0, i));
    rest = rest.slice(i + 2);
  }
  return { events, rest };
}

export type StreamEvent = { type: 'delta'; text: string } | { type: 'error'; text: string } | { type: 'finish' } | { type: 'done' };

/** 一个 SSE 事件 → 我们关心的事件（其余忽略） */
export function parseEvent(event: string): StreamEvent | null {
  const data = event
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  if (data === '[DONE]') return { type: 'done' };
  try {
    const j = JSON.parse(data) as { type?: string; delta?: unknown; errorText?: unknown };
    if (j.type === 'text-delta' && typeof j.delta === 'string') return { type: 'delta', text: j.delta };
    if (j.type === 'error') return { type: 'error', text: typeof j.errorText === 'string' ? j.errorText : '对话出错了，请稍后再试。' };
    if (j.type === 'finish') return { type: 'finish' };
  } catch {
    /* 不是 JSON：忽略 */
  }
  return null;
}

export class ChatStreamError extends Error {}

export const NETWORK_ERROR = '连不上 Aroomo，请检查网络后点「重试」。';

/**
 * 发一次对话，逐段产出「到目前为止的完整回复」。中断（signal）时安静结束。
 * 服务端返回错误（401/403/429/400）或流里有 error 事件时抛 ChatStreamError（文案给人看）。
 */
export async function* streamChat(turns: ChatTurn[], model: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): AsyncGenerator<string, void> {
  let res: Response;
  try {
    res = await fetchImpl(STREAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-aroomo-request': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ model, messages: turns.map((t) => ({ role: t.role, content: t.text })) }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    // 断网 / 服务没开：给人看的话，不把浏览器的英文报错原样露出来
    throw new ChatStreamError(NETWORK_ERROR);
  }
  if (!res.ok || !res.body) {
    let msg = '对话出错了，请稍后再试。';
    if (res.status === 401) msg = '登录已过期，请重新登录。';
    else if (res.status === 429) msg = '说得太快了，请稍等一下再发。';
    else {
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) msg = j.error.message;
      } catch {
        /* 用默认文案 */
      }
    }
    throw new ChatStreamError(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { events, rest } = splitSse(buf + dec.decode(value, { stream: true }));
      buf = rest;
      for (const e of events) {
        const ev = parseEvent(e);
        if (!ev) continue;
        if (ev.type === 'delta') {
          text += ev.text;
          yield text;
        } else if (ev.type === 'error') throw new ChatStreamError(ev.text);
        else if (ev.type === 'done') return;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** 群聊里没写 @ 时，自动 @ 群里的成员（只改发出去的文字，界面上显示原话） */
export function withGroupMentions(text: string, group: string[] | undefined): string {
  if (!group?.length || /(^|\s)[@＠]\S/.test(text)) return text;
  return `${group.map((n) => `@${n}`).join(' ')} ${text}`;
}

// ---- 本机存储 ----

const KEY = 'aroomo.chat.v1';
export const MAX_CONVERSATIONS = 200;

export function loadConversations(storage: Storage | undefined = globalThis.localStorage): Conversation[] {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((c): c is Conversation => !!c && typeof c === 'object' && typeof (c as Conversation).id === 'string' && Array.isArray((c as Conversation).messages))
      .map((c) => ({
        ...c,
        title: String(c.title ?? '新对话'),
        model: typeof c.model === 'string' ? c.model : 'aroomo',
        messages: c.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string'),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[], storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(list.slice(0, MAX_CONVERSATIONS)));
  } catch {
    /* 存满了或隐私模式：这次不存 */
  }
}

export function newConversation(opts: Partial<Pick<Conversation, 'title' | 'model' | 'group'>> = {}): Conversation {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(16).slice(2)}`;
  return { id, title: opts.title ?? '新对话', model: opts.model ?? 'aroomo', ...(opts.group ? { group: opts.group } : {}), messages: [], updatedAt: Date.now() };
}

/** 用第一句话起标题（最多 20 个字） */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 20 ? `${t.slice(0, 20)}…` : t) : '新对话';
}

export interface ChatPrefs {
  /** 字号（px），默认 16；作用到整个页面（见 lib/display.ts） */
  fontSize: number;
  highContrast: boolean;
  /** 跟随系统 / 浅色 / 深色 */
  theme: Theme;
}
export const FONT_SIZES = [16, 18, 20, 24, 28] as const;

export function loadPrefs(storage: Storage | undefined = globalThis.localStorage): ChatPrefs {
  const d = readDisplayPrefs(storage);
  try {
    const j = JSON.parse(storage?.getItem(PREFS_KEY) ?? '{}') as Partial<ChatPrefs>;
    return { ...d, highContrast: j.highContrast === true };
  } catch {
    return { ...d, highContrast: false };
  }
}

export function savePrefs(p: ChatPrefs, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 忽略 */
  }
}

// ---- 草稿：每个会话一份，没发出去的话不丢（切会话、刷新、重新登录后还在） ----

const DRAFT_KEY = 'aroomo.chat.drafts.v1';

function readDrafts(storage: Storage | undefined): Record<string, string> {
  try {
    const j = JSON.parse(storage?.getItem(DRAFT_KEY) ?? '{}') as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadDraft(id: string, storage: Storage | undefined = globalThis.localStorage): string {
  const v = readDrafts(storage)[id];
  return typeof v === 'string' ? v : '';
}

export function saveDraft(id: string, text: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    const all = readDrafts(storage);
    if (text.trim()) all[id] = text.slice(0, 32000);
    else delete all[id];
    const keys = Object.keys(all);
    // 最多留 50 份，删掉最早的
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
    storage?.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    /* 忽略 */
  }
}

/** 从回复末尾的署名「— 名字」里取出是谁回答的（Core 的 D31 署名）；没有署名返回 null */
export function signatureOf(text: string): string | null {
  const m = /(?:^|\n)\s*[—–]\s*([^\n—–]{1,40}?)\s*$/.exec(text);
  return m ? m[1]!.trim() : null;
}
