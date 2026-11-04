/**
 * 原生对话（#250 spike）：调用 Core 的 POST /api/chat/stream，读 AI SDK UI Message Stream（SSE）。
 * - 只靠控制台会话 Cookie（HttpOnly，脚本读不到）+ X-Aroomo-Request 头；从不发 Authorization，从不碰任何 Key。
 * - 会话列表和消息先存在本机浏览器 localStorage（S1 再落库）。
 */

import { FONT_VERSION, PREFS_KEY, readDisplayPrefs, type Theme } from '@/lib/display';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** 发出 / 收到的时间（毫秒）；旧会话没有 */
  at?: number;
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

/** 整条回复失败的原因（Core 只发这 4 种，审查点 1 补充裁决 1）；界面据此决定显示「重试」还是「去检查 Key」 */
export type FailureCode = 'gateway_unreachable' | 'key_invalid' | 'rate_limited' | 'upstream_error';
const FAILURE_CODES: readonly string[] = ['gateway_unreachable', 'key_invalid', 'rate_limited', 'upstream_error'];
/** Core 随 error 发来的失败码部件（AI SDK UI Message Stream 的 data-* 部件） */
export const FAILURE_PART = 'data-aroomo-failure';

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; text: string }
  | { type: 'failure'; code: FailureCode }
  | { type: 'finish' }
  | { type: 'done' };

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
    const j = JSON.parse(data) as { type?: string; delta?: unknown; errorText?: unknown; data?: { code?: unknown } };
    if (j.type === 'text-delta' && typeof j.delta === 'string') return { type: 'delta', text: j.delta };
    if (j.type === FAILURE_PART && typeof j.data?.code === 'string' && FAILURE_CODES.includes(j.data.code)) return { type: 'failure', code: j.data.code as FailureCode };
    if (j.type === 'error') return { type: 'error', text: typeof j.errorText === 'string' ? j.errorText : '对话出错了，请稍后再试。' };
    if (j.type === 'finish') return { type: 'finish' };
  } catch {
    /* 不是 JSON：忽略 */
  }
  return null;
}

export class ChatStreamError extends Error {
  /** Core 给了失败码时带上（key_invalid 不显示「重试」，改成「去检查 Key」） */
  readonly code: FailureCode | undefined;
  constructor(message: string, code?: FailureCode) {
    super(message);
    this.code = code;
  }
}

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
  let code: FailureCode | undefined;
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
        } else if (ev.type === 'failure') code = ev.code;
        else if (ev.type === 'error') throw new ChatStreamError(ev.text, code);
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
  /** 正文字号（px，12–32 连续可调），默认 14 = sumus 原样；作用到整个页面（见 lib/display.ts） */
  fontSize: number;
  highContrast: boolean;
  /** 跟随系统 / 浅色 / 深色 */
  theme: Theme;
  /** 朗读语速（0.8–1.5，默认 1.0） */
  speechRate: number;
  /** 本机没有中文语音时，所有者点过「用在线语音」（文字会发到 Google 或微软合成） */
  speechOnline: boolean;
}

export function loadPrefs(storage: Storage | undefined = globalThis.localStorage): ChatPrefs {
  const d = readDisplayPrefs(storage);
  try {
    const j = JSON.parse(storage?.getItem(PREFS_KEY) ?? '{}') as Partial<ChatPrefs>;
    const rate = typeof j.speechRate === 'number' && j.speechRate >= 0.8 && j.speechRate <= 1.5 ? j.speechRate : 1;
    return { ...d, highContrast: j.highContrast === true, speechRate: rate, speechOnline: j.speechOnline === true };
  } catch {
    return { ...d, highContrast: false, speechRate: 1, speechOnline: false };
  }
}

export function savePrefs(p: ChatPrefs, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ ...p, fontV: FONT_VERSION }));
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

/** 去掉回复末尾的署名行「— 名字」（名字已显示在头像旁边，不再重复） */
export function stripSignature(text: string): string {
  return text.replace(/\n?\s*[—–]\s*[^\n—–]{1,40}?\s*$/, '').replace(/\s+$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 消息旁的时间：14:05 */
export function timeLabel(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 会话列表里的时间：今天 14:05 / 昨天 / 周三 / 11月2日 */
export function listTimeLabel(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = new Date(ts);
  const n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff <= 0) return timeLabel(ts);
  if (diff === 1) return '昨天';
  if (diff < 7) return `周${'日一二三四五六'[d.getDay()]}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 对话区顶部的日期分隔：今天 / 昨天 / 11月2日 */
export function dayLabel(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const l = listTimeLabel(ts, now);
  return /^\d\d:\d\d$/.test(l) ? '今天' : l;
}
