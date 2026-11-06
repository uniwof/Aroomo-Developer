/**
 * 原生对话（#250 spike）：调用 Core 的 POST /api/chat/stream，读 AI SDK UI Message Stream（SSE）。
 * - 只靠控制台会话 Cookie（HttpOnly，脚本读不到）+ X-Aroomo-Request 头；从不发 Authorization，从不碰任何 Key。
 * - 会话列表和消息：开关 FLAGS.savedChats 打开且 Core 可用时存在 Core（saved.ts）；否则存在本机浏览器 localStorage。
 */

import { FONT_VERSION, PREFS_KEY, readDisplayPrefs, type Theme } from '@/lib/display';
import type { DraftPart } from '@/lib/assistants';

/** X-15：负责人在聊天里回的助手草稿卡（Core 的 data-aroomo-assistant-draft 数据块）+ 她点过什么 */
export interface ChatDraft {
  /** Core 给的 id（draft_…），「建好」时当幂等键 */
  id: string;
  data: DraftPart['data'];
  /** 点过「建好」= done，「不用了」= dismissed；没点 = 还能操作 */
  state?: 'done' | 'dismissed';
}

/**
 * X-05：回复里的一个工具调用（Core 的 data-aroomo-tool 数据块，docs/api/stream-parts.md §1）。
 * Core 已经脱敏；家人账号没有 args / result。浏览器只显示，不发回 Core。
 */
export interface ChatTool {
  index: number;
  name: string;
  /** 人话：「搜了网页」 */
  label: string;
  state: 'done' | 'failed' | 'unavailable';
  count?: number;
  summary: string;
  args?: string;
  result?: string;
}
export const TOOL_PART = 'data-aroomo-tool';
const TOOL_STATES: readonly string[] = ['done', 'failed', 'unavailable'];
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** 数据块 / 本机存储 / Core 消息里的工具调用要长这样才认（缺字段的丢掉，不渲染半行） */
export function asTool(v: unknown): ChatTool | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.index !== 'number' || !Number.isInteger(o.index) || o.index < 0 || o.index > 99) return null;
  const name = str(o.name, 64);
  const label = str(o.label, 80);
  const summary = str(o.summary, 200);
  if (!name || !label || summary === undefined || typeof o.state !== 'string' || !TOOL_STATES.includes(o.state)) return null;
  const args = str(o.args, 2000);
  const result = str(o.result, 3000);
  return {
    index: o.index,
    name,
    label,
    state: o.state as ChatTool['state'],
    summary,
    ...(typeof o.count === 'number' && Number.isInteger(o.count) && o.count >= 0 ? { count: o.count } : {}),
    ...(args ? { args } : {}),
    ...(result ? { result } : {}),
  };
}
export const asTools = (v: unknown): ChatTool[] => (Array.isArray(v) ? v.map(asTool).filter((t): t is ChatTool => t !== null).slice(0, 20) : []);

/** 同一个 index 的新数据覆盖旧的（流里同一个调用会发好几次），按 index 排序 */
export function upsertTool(list: ChatTool[] | undefined, t: ChatTool): ChatTool[] {
  return [...(list ?? []).filter((x) => x.index !== t.index), t].sort((a, b) => a.index - b.index);
}

export interface ChatTurn {
  /** Core 里的消息 id（存库的会话才有；收件箱跳到某条消息用） */
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  /** 发出 / 收到的时间（毫秒）；旧会话没有 */
  at?: number;
  /** 只在回复上：助手草稿卡 */
  draft?: ChatDraft;
  /** X-19：这条上面那行灰字（「已把 … 之前的内容整理成摘要…」）；只来自 Core */
  note?: string;
  /** 只在回复上：X-05 工具调用 */
  tools?: ChatTool[];
}

export const DRAFT_PART = 'data-aroomo-assistant-draft';

/** 数据块 / 本机存储里的草稿卡要长这样才认（缺字段的当没有，不渲染半张卡） */
export function asDraft(v: unknown): ChatDraft | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { id?: unknown; data?: unknown; state?: unknown };
  const d = o.data as Partial<DraftPart['data']> | undefined;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(o.id) || !d || typeof d !== 'object') return null;
  if (typeof d.name !== 'string' || typeof d.instructions !== 'string' || !Array.isArray(d.members) || typeof d.leadMemberId !== 'string' || !d.schedule || typeof d.schedule.kind !== 'string') return null;
  return { id: o.id, data: d as DraftPart['data'], ...(o.state === 'done' || o.state === 'dismissed' ? { state: o.state } : {}) };
}

export interface Conversation {
  id: string;
  title: string;
  /** 'aroomo' = 交给负责人（可 @ 点名）；'aroomo/<成员 id>' = 单独和这位成员对话 */
  model: string;
  /** 挑选的成员（落地方案 v2：默认只有负责人回答，@ 谁谁答；@ 列表只列这几位） */
  group?: string[];
  messages: ChatTurn[];
  updatedAt: number;
  /** 存在 Core 里的会话才有（saved.ts）：消息点开时再取 */
  remote?: RemoteInfo;
}

export interface RemoteInfo {
  /** 消息已经取过 */
  loaded: boolean;
  unread: boolean;
  running: boolean;
  /** 消息条数（没取消息时判断列表里显不显示） */
  count: number;
  /** 最后一条的预览（没取消息时列表用） */
  last?: { role: 'user' | 'assistant' | 'system'; text: string; at: number | undefined };
}

/** 发一轮时要不要让 Core 存：conversationId = 存到哪个会话；retry = 重试（Core 不再存用户这句） */
export interface PersistOpts {
  conversationId?: string;
  retry?: boolean;
  /** Core 收下了这次请求（HTTP 200）：用户这句已经存了 */
  onAccepted?: () => void;
  /** X-19：Core 发话前刚压缩过：keep = 留着原文的条数（含这句），text = 灰字 */
  onCompacted?: (c: { keep: number; text: string }) => void;
  /** Core 该压缩却没压成，这次只带了最近的内容：text = 灰字（只在流里，不存库） */
  onTruncated?: (text: string) => void;
  /** 群聊挑的成员名单（审计 C9）：Core 只交给这几位；会话已存库时 Core 以库里的为准 */
  group?: string[];
}

/** X-19：Core 发来的「刚压缩过」部件 */
export const COMPACTED_PART = 'data-aroomo-compacted';
/** 该压缩却没压成、只带了最近的原文（负责人阶段 3 必改 3）：这条回复上面一行灰字，只在流里、不存库 */
export const TRUNCATED_PART = 'data-aroomo-truncated';
export const TRUNCATED_TEXT = '这段对话太长，这次只带了最近的内容';

/**
 * 发给 Core 的历史只取最近 ≤ 100 条、≤ 120,000 字（至少最后一句）：以前超过 200 条直接 400。
 * 存库的会话由 Core 按库里的原文 + 摘要拼上下文（X-19），本机会话就只带最近这些。
 */
export const SEND_MAX_TURNS = 100;
export const SEND_MAX_CHARS = 120_000;
export function capTurns(turns: ChatTurn[]): ChatTurn[] {
  let n = 0;
  let total = 0;
  for (let i = turns.length - 1; i >= 0 && n < SEND_MAX_TURNS; i--) {
    total += turns[i]!.text.length;
    if (n > 0 && total > SEND_MAX_CHARS) break;
    n++;
  }
  return turns.slice(turns.length - n);
}

/**
 * 永远是同源相对路径：从 Shell 打开时由 Shell 白名单直通 Core（只带会话 Cookie，不带主人令牌，不走 /aroomo/api），
 * 直接从 Core 打开时就是 Core 自己。不依赖任何聊天子域名（负责人 2026-11-05 19:47 裁定）。
 */
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
  | { type: 'draft'; draft: ChatDraft }
  | { type: 'compacted'; keep: number; text: string }
  | { type: 'truncated'; text: string }
  | { type: 'tool'; tool: ChatTool }
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
    const j = JSON.parse(data) as { type?: string; delta?: unknown; errorText?: unknown; data?: { code?: unknown; keep?: unknown; text?: unknown } };
    if (j.type === 'text-delta' && typeof j.delta === 'string') return { type: 'delta', text: j.delta };
    if (j.type === DRAFT_PART) {
      const d = asDraft(j);
      return d ? { type: 'draft', draft: d } : null;
    }
    if (j.type === COMPACTED_PART && typeof j.data?.keep === 'number' && typeof j.data.text === 'string') return { type: 'compacted', keep: j.data.keep, text: j.data.text };
    if (j.type === TRUNCATED_PART) return { type: 'truncated', text: typeof j.data?.text === 'string' ? j.data.text : TRUNCATED_TEXT };
    if (j.type === TOOL_PART) {
      const t = asTool(j.data);
      return t ? { type: 'tool', tool: t } : null;
    }
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
  /** 对话接口回的 HTTP 状态（没连上 / 流里出错时没有）；从 Shell 打开时 401/403/404 说明要直接打开 Aroomo 网页（审计 C12） */
  readonly status: number | undefined;
  constructor(message: string, code?: FailureCode, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const NETWORK_ERROR = '连不上 Aroomo，请检查网络后点「重试」。';

/**
 * 发一次对话，逐段产出「到目前为止的完整回复」。中断（signal）时安静结束。
 * 服务端返回错误（401/403/429/400）或流里有 error 事件时抛 ChatStreamError（文案给人看）。
 */
export async function* streamChat(
  turns: ChatTurn[],
  model: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  onDraft?: (d: ChatDraft) => void,
  persist: PersistOpts = {},
  /** X-05：每收到一次工具调用的数据（同一个 index 会来好几次，按 index 覆盖） */
  onTool?: (t: ChatTool) => void,
): AsyncGenerator<string, void> {
  let res: Response;
  try {
    res = await fetchImpl(STREAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-aroomo-request': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({
        model,
        messages: capTurns(turns).map((t) => ({ role: t.role, content: t.text })),
        ...(persist.conversationId ? { conversationId: persist.conversationId, ...(persist.retry ? { retry: true } : {}) } : {}),
        ...(persist.group?.length ? { group: persist.group } : {}),
      }),
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
    throw new ChatStreamError(msg, undefined, res.status);
  }
  persist.onAccepted?.();
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
        } else if (ev.type === 'draft') onDraft?.(ev.draft);
        else if (ev.type === 'compacted') persist.onCompacted?.({ keep: ev.keep, text: ev.text });
        else if (ev.type === 'truncated') persist.onTruncated?.(ev.text);
        else if (ev.type === 'tool') onTool?.(ev.tool);
        else if (ev.type === 'failure') code = ev.code;
        else if (ev.type === 'error') throw new ChatStreamError(ev.text, code);
        else if (ev.type === 'done') return;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}


// ---- 本机存储 ----

/** 旧的共用键（#287 之前所有账号共用一份，看不出是谁存的）：只在不知道是哪个账号时读写，永不导入 */
export const LEGACY_KEY = 'aroomo.chat.v1';
export const MAX_CONVERSATIONS = 200;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 本机会话的键：知道账号就按账号分开（#287），不知道就是旧的共用键 */
export const chatKey = (account: string | null = null) => (account && ACCOUNT_RE.test(account) ? `${LEGACY_KEY}:u:${account}` : LEGACY_KEY);

export function loadConversations(account: string | null = null, storage: Storage | undefined = globalThis.localStorage): Conversation[] {
  try {
    const raw = storage?.getItem(chatKey(account));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((c): c is Conversation => !!c && typeof c === 'object' && typeof (c as Conversation).id === 'string' && Array.isArray((c as Conversation).messages))
      .map((c) => ({
        ...c,
        title: String(c.title ?? '新对话'),
        model: typeof c.model === 'string' ? c.model : 'aroomo',
        messages: c.messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
          .map(({ draft, tools, ...m }) => {
            const d = m.role === 'assistant' ? asDraft(draft) : null;
            const t = m.role === 'assistant' ? asTools(tools) : [];
            return { ...m, ...(d ? { draft: d } : {}), ...(t.length ? { tools: t } : {}) };
          }),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[], account: string | null = null, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(chatKey(account), JSON.stringify(list.slice(0, MAX_CONVERSATIONS)));
  } catch {
    /* 存满了或隐私模式：这次不存 */
  }
}

/** #290：所有者认领过旧的共用那份（按账号记一笔；共用那份不删） */
const claimedKey = (account: string) => `${LEGACY_KEY}.claimed:u:${account}`;
export function legacyClaimed(account: string, storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(claimedKey(account)) === '1';
  } catch {
    return false;
  }
}

/** 共用那份里又有了她没认领的新内容（负责人 #294 第二轮）：清掉「已认领」，提示和按钮重新出来 */
export function clearLegacyClaimed(account: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(claimedKey(account));
  } catch {
    /* 隐私模式：不提示也不丢，下次再说 */
  }
}

/** #290：放不下（超过上限或浏览器存满）：再点也没用，界面要换一句话（负责人 #294 必改 2） */
export class ClaimFullError extends Error {}

/**
 * #290：把旧的共用那份（有消息的）复制进这个账号自己那份，按 id 去重（点两次不重复）；同一个 id 共用那份更新就替换。共用那份不删、不改。
 * 写完读回核对每一段都在（且不比共用那份旧），才记「已认领」；存不下（超过上限、存满）就抛错，什么都不记。返回复制或替换了几段。
 * 账号必须是 Core 确认过的所有者（调用方负责）。
 */
export function claimLegacy(account: string, storage: Storage = globalThis.localStorage): number {
  if (!ACCOUNT_RE.test(account)) throw new Error('bad account');
  const legacy = loadConversations(null, storage).filter((c) => c.messages.length > 0);
  const mine = loadConversations(account, storage);
  const byId = new Map(mine.map((c) => [c.id, c]));
  // 没有的复制；同一个 id 共用那份更新（更晚、消息更多：她在共用那份里接着说过，负责人 #294 第二轮）就替换她那份里的这段。
  // 只在她那份是共用那份的开头时替换（共用那份只是多说了几句）；两边各自接着说过（分叉）不替换，她那份一句不丢。
  // shortcut: 分叉时共用那份多出来的话留在共用那份、不进她账号；很少见，以后要的话改成按消息合并
  const newer = (a: Conversation, b: Conversation) =>
    a.updatedAt > b.updatedAt && a.messages.length > b.messages.length && b.messages.every((m, i) => a.messages[i]!.role === m.role && a.messages[i]!.text === m.text);
  const add = legacy.filter((c) => !byId.has(c.id) || newer(c, byId.get(c.id)!));
  if (add.length) {
    for (const c of add) byId.set(c.id, c);
    const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (merged.length > MAX_CONVERSATIONS) throw new ClaimFullError('too many');
    try {
      storage.setItem(chatKey(account), JSON.stringify(merged));
    } catch (e) {
      throw e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22) ? new ClaimFullError('quota') : e;
    }
  }
  const saved = new Map(loadConversations(account, storage).map((c) => [c.id, c]));
  if (!legacy.every((c) => saved.has(c.id) && !newer(c, saved.get(c.id)!))) throw new Error('not saved');
  storage.setItem(claimedKey(account), '1');
  return add.length;
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

/**
 * 会话列表 / 话题菜单的一行预览：去署名，图片写成「[图片：说明]」（没说明就「[图片]」），链接只留文字，再去掉 Markdown 符号。
 * 以前直接删符号，带图的回复会露出整段图片网址。
 */
export function previewText(text: string): string {
  return stripSignature(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? ` [图片：${alt.trim()}] ` : ' [图片] '))
    .replace(/<img\b[^>]*>/gi, ' [图片] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
