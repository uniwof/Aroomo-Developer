/**
 * 会话存库（#250 integrate/stage2，开关 FLAGS.savedChats）：对话列表和消息从 Core 的 /api/conversations 读，
 * 发消息时 /api/chat/stream 带 conversationId，由 Core 只追加地存（X-21）。
 * 所有者第一次打开时把浏览器本机的旧会话导入一次（本机那份不删）；家人账号不导入（同一台浏览器上的本机会话是所有者的）。
 */
import { api } from '@/lib/api';
import { asDraft, type ChatTurn, type Conversation } from './store';

export interface ConvJson {
  id: string;
  title: string;
  model: string;
  group: string[];
  archived: boolean;
  unread: boolean;
  running: boolean;
  messageCount: number;
  last: { role: 'user' | 'assistant' | 'system'; preview: string; createdAt: string } | null;
  updatedAt: string;
}
interface MsgJson {
  id: string;
  seq: number;
  /** system = X-19 摘要行：content 是灰字，summary.toSeq = 被整理的最后一条 */
  role: 'user' | 'assistant' | 'system';
  content: string;
  draft?: { id: string; data: unknown };
  summary?: { toSeq: number };
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** 本机旧 id 不是 uuid 时，按它算一个固定的 uuid（同一份本机会话在两台设备上导入也只算一个） */
async function uuidFrom(localId: string): Promise<string> {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`aroomo-local:${localId}`)))].slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Core 的一行 → 页面里的会话（消息点开时再取，loaded=false） */
export function fromJson(c: ConvJson): Conversation {
  return {
    id: c.id,
    title: c.title,
    model: c.model,
    ...(c.group.length ? { group: c.group } : {}),
    messages: [],
    updatedAt: Date.parse(c.updatedAt) || Date.now(),
    remote: {
      loaded: false,
      unread: c.unread,
      running: c.running,
      count: c.messageCount,
      ...(c.last ? { last: { role: c.last.role, text: c.last.preview, at: Date.parse(c.last.createdAt) || undefined } } : {}),
    },
  };
}

const LIST_PAGE = 100;
const LIST_PAGES = 3;

/** 最近的会话（最多 300 个；更早的以后加「加载更多」） */
export async function fetchConversations(): Promise<Conversation[]> {
  const out: Conversation[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < LIST_PAGES; i++) {
    const r: { conversations: ConvJson[]; nextCursor: string | null } = await api('GET', `/api/conversations?limit=${LIST_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...r.conversations.map(fromJson));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export async function fetchConversation(id: string): Promise<Conversation> {
  return fromJson((await api<{ conversation: ConvJson }>('GET', `/api/conversations/${id}`)).conversation);
}

const MSG_PAGE = 200;
const MSG_MAX = 1000;

/** 一个会话的消息（最近的 1000 条，按顺序） */
export async function fetchMessages(id: string): Promise<ChatTurn[]> {
  let rows: MsgJson[] = [];
  let before: number | undefined;
  for (;;) {
    const r = await api<{ messages: MsgJson[]; hasMore: boolean }>('GET', `/api/conversations/${id}/messages?limit=${MSG_PAGE}${before ? `&beforeSeq=${before}` : ''}`);
    rows = [...r.messages, ...rows];
    if (!r.hasMore || !r.messages.length || rows.length >= MSG_MAX) break;
    before = r.messages[0]!.seq;
  }
  // X-19 摘要行不进对话，变成「留下的第一条原文」上面的那行灰字
  const notes = new Map<string, string>();
  for (const m of rows) {
    if (m.role !== 'system' || !m.summary) continue;
    const first = rows.find((x) => x.role !== 'system' && x.seq > m.summary!.toSeq);
    if (first) notes.set(first.id, m.content);
  }
  return rows
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const draft = m.role === 'assistant' && m.draft ? asDraft(m.draft) : null;
      const note = notes.get(m.id);
      return { id: m.id, role: m.role, text: m.content, at: Date.parse(m.createdAt) || undefined, ...(draft ? { draft } : {}), ...(note ? { note } : {}) } as ChatTurn;
    });
}

export async function createConversation(c: Pick<Conversation, 'id' | 'title' | 'model' | 'group'>): Promise<Conversation> {
  const body = { ...(isUuid(c.id) ? { id: c.id } : {}), title: c.title, model: c.model, ...(c.group?.length ? { group: c.group } : {}) };
  return fromJson((await api<{ conversation: ConvJson }>('POST', '/api/conversations', body)).conversation);
}

/** X-09 搜消息正文的一条结果 */
export interface SearchResult {
  conversationId: string;
  title: string;
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
  createdAt: string;
}

/** X-09：搜本账号的消息正文（最近的 20 条） */
export async function searchMessages(q: string): Promise<SearchResult[]> {
  return (await api<{ results: SearchResult[] }>('GET', `/api/search?q=${encodeURIComponent(q.slice(0, 100))}&limit=20`)).results;
}

export const renameConversation = (id: string, title: string) => api('PATCH', `/api/conversations/${id}`, { title });
export const archiveConversation = (id: string) => api('PATCH', `/api/conversations/${id}`, { archived: true });
export const markRead = (id: string) => api('POST', `/api/conversations/${id}/read`, {});

// ---- 一次性导入本机会话（只给所有者） ----

export const IMPORTED_KEY = 'aroomo.chat.imported.v1';
const IMPORT_BATCH = 50;

function importedIds(storage: Storage): Set<string> {
  try {
    const v = JSON.parse(storage.getItem(IMPORTED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * 把还没导入过的本机会话交给 Core（按 id 幂等，导过的记在本机，不再发）。本机那份不删、不改。
 * 本机 id 不是 uuid 的（很旧的会话）按它算一个固定的 uuid。返回导入了几个；失败抛错，下次打开再试。
 */
export async function importLocalOnce(local: Conversation[], storage: Storage = localStorage): Promise<number> {
  const done = importedIds(storage);
  const todo = local.filter((c) => c.messages.length > 0 && !done.has(c.id));
  let n = 0;
  for (let i = 0; i < todo.length; i += IMPORT_BATCH) {
    const batch = todo.slice(i, i + IMPORT_BATCH);
    const ids = await Promise.all(batch.map((c) => (isUuid(c.id) ? c.id : uuidFrom(c.id))));
    const r = await api<{ imported: number }>('POST', '/api/conversations/import', {
      conversations: batch.map((c, k) => ({
        id: ids[k]!,
        title: c.title.slice(0, 200),
        model: c.model,
        ...(c.group?.length ? { group: c.group.slice(0, 20) } : {}),
        updatedAt: Math.max(0, Math.round(c.updatedAt)),
        messages: c.messages.slice(-500).filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text.slice(0, 50_000), ...(m.at ? { at: Math.round(m.at) } : {}) })),
      })),
    });
    n += r.imported;
    for (const c of batch) done.add(c.id);
    try {
      storage.setItem(IMPORTED_KEY, JSON.stringify([...done]));
    } catch {
      /* 存不了：下次再导一次，Core 按 id 跳过 */
    }
  }
  return n;
}

/**
 * 定时刷新列表时合并：Core 的新状态（未读、进行中、标题、预览）盖上去，已经取过的消息和本机还没建到 Core 的新会话留着。
 */
export function mergeRemote(prev: Conversation[], fresh: Conversation[], keep: string | null = null): Conversation[] {
  const old = new Map(prev.map((c) => [c.id, c]));
  const ids = new Set(fresh.map((c) => c.id));
  const merged = fresh.map((f) => {
    const o = old.get(f.id);
    if (!o?.remote?.loaded) return f;
    // 别处（另一台设备）又说过话：不是正打开的会话就下次点开时重取；正打开的保留现状，免得对话区重挂
    if (o.id !== keep && f.remote!.count !== o.messages.length) return f;
    return { ...o, title: f.title, updatedAt: Math.max(o.updatedAt, f.updatedAt), remote: { ...f.remote!, loaded: true } };
  });
  const localOnly = prev.filter((c) => !ids.has(c.id) && !c.remote);
  return [...localOnly, ...merged].sort((a, b) => b.updatedAt - a.updatedAt);
}
