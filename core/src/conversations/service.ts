/** 会话存库的业务规则（接口见 routes.ts；聊天流落库见 chat/stream.ts 的 conversations 选项）。 */
import { randomUUID } from 'node:crypto';
import { HttpError, notFound } from '../http/errors.js';
import { CONTENT_MAX, TITLE_MAX, type ChatConversation, type ChatMessage, type ChatMessageMeta, type ConversationStore, type ConversationSummary } from './types.js';

export const DEFAULT_TITLE = '新对话';
export const MODEL_RE = /^aroomo(\/[^\s]{1,100})?$/;
export const PREVIEW_MAX = 200;
export type ConvFilter = 'all' | 'unread' | 'running';

export interface ImportInput {
  id: string;
  title?: string;
  model?: string;
  group?: string[];
  updatedAt?: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string; at?: number }>;
}

/**
 * 哪些会话正在生成回复（X-22 / X-27「进行中」）。
 * shortcut: 内存态、单实例；重启后清空（没写完的回复本来也断了）。多实例部署时改成共享存储（同 UserRateLimiter）。
 */
export class RunningConversations {
  readonly #open = new Map<string, number>();
  begin(userId: string, id: string): () => void {
    const k = `${userId}\n${id}`;
    this.#open.set(k, (this.#open.get(k) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.#open.get(k) ?? 1) - 1;
      if (n <= 0) this.#open.delete(k);
      else this.#open.set(k, n);
    };
  }
  ids(userId: string): string[] {
    const p = `${userId}\n`;
    return [...this.#open.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const cleanTitle = (t: string | undefined) => clip((t ?? '').replace(/\s+/g, ' ').trim(), TITLE_MAX) || DEFAULT_TITLE;

export function encodeCursor(c: ChatConversation): string {
  return Buffer.from(`${c.updatedAt.toISOString()}|${c.id}`).toString('base64url');
}
export function decodeCursor(s: string): { updatedAt: Date; id: string } {
  const [iso, id] = Buffer.from(s, 'base64url').toString('utf8').split('|');
  const d = new Date(iso ?? '');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(d.getTime())) throw new HttpError(400, 'BAD_REQUEST', '翻页游标不对');
  return { updatedAt: d, id };
}

export function messageJson(m: ChatMessage) {
  return {
    id: m.id,
    seq: m.seq ?? null,
    role: m.role,
    content: m.content,
    ...(m.meta?.draft ? { draft: m.meta.draft } : {}),
    ...(m.meta?.tools?.length ? { tools: m.meta.tools } : {}),
    ...(m.meta?.imported ? { imported: true } : {}),
    createdAt: m.createdAt.toISOString(),
  };
}

export class ConversationService {
  readonly running = new RunningConversations();
  constructor(private readonly d: { store: ConversationStore; now: () => Date }) {}

  #json(c: ChatConversation, s?: Omit<ConversationSummary, 'conversation'>) {
    return {
      id: c.id,
      title: c.title,
      model: c.model,
      group: c.groupNames,
      archived: c.archivedAt !== null,
      unread: s?.unread ?? false,
      running: this.running.ids(c.userId).includes(c.id),
      messageCount: s?.messageCount ?? 0,
      last: s?.last ? { role: s.last.role, preview: clip(s.last.content, PREVIEW_MAX), createdAt: s.last.createdAt.toISOString() } : null,
      readAt: c.readAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  async list(userId: string, q: { filter: ConvFilter; archived: boolean; limit: number; cursor?: string }) {
    const ids = q.filter === 'running' ? this.running.ids(userId) : undefined;
    if (ids && ids.length === 0) return { conversations: [], nextCursor: null };
    const rows = await this.d.store.list(userId, {
      archived: q.archived,
      unreadOnly: q.filter === 'unread',
      ...(ids ? { ids } : {}),
      limit: q.limit + 1,
      ...(q.cursor ? { before: decodeCursor(q.cursor) } : {}),
    });
    const page = rows.slice(0, q.limit);
    return {
      conversations: page.map(({ conversation, ...s }) => this.#json(conversation, s)),
      nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!.conversation) : null,
    };
  }

  async get(userId: string, id: string): Promise<ChatConversation> {
    const c = await this.d.store.get(userId, id);
    if (!c) throw notFound('找不到这个会话');
    return c;
  }

  async getJson(userId: string, id: string) {
    const c = await this.get(userId, id);
    const s = (await this.d.store.list(userId, { archived: c.archivedAt !== null, unreadOnly: false, ids: [id], limit: 1 }))[0];
    return this.#json(c, s);
  }

  /**
   * 建会话。客户端可以自带 id（本机会话发第一句时建，id 不变，界面不用重挂）：
   * 本账号已有 → 原样返回（created=false）；被别的会话占用 → 换一个新 id（不回 409；不泄露那个会话的内容，但返回的 id 和给的不同，调用方能推知「已被占用」——uuid 随机、猜不中，可接受，见 design-conversations-v1）。
   */
  async create(userId: string, input: { id?: string; title?: string; model?: string; group?: string[] }, messages: ChatMessage[] = [], updatedAt?: Date) {
    const model = input.model ?? 'aroomo';
    if (!MODEL_RE.test(model)) throw new HttpError(400, 'BAD_REQUEST', '模型名不对');
    const now = this.d.now();
    let c: ChatConversation = {
      id: input.id ?? randomUUID(),
      userId,
      title: cleanTitle(input.title),
      model,
      groupNames: (input.group ?? []).map((g) => g.trim()).filter(Boolean),
      readAt: now,
      archivedAt: null,
      createdAt: now,
      updatedAt: updatedAt ?? now,
    };
    let r = await this.d.store.create(userId, c, messages);
    if (r === 'conflict') {
      c = { ...c, id: randomUUID() };
      r = await this.d.store.create(userId, c, messages);
    }
    if (r === 'exists') return { conversation: await this.getJson(userId, c.id), created: false };
    if (r !== 'ok') throw new HttpError(409, 'CONFLICT', '会话没建成，请重试');
    return { conversation: await this.getJson(userId, c.id), created: true };
  }

  async update(userId: string, id: string, patch: { title?: string; archived?: boolean }) {
    const p: Partial<Pick<ChatConversation, 'title' | 'archivedAt'>> = {};
    if (patch.title !== undefined) {
      const t = patch.title.replace(/\s+/g, ' ').trim();
      if (!t) throw new HttpError(400, 'BAD_REQUEST', '名字不能是空的');
      p.title = clip(t, TITLE_MAX);
    }
    if (patch.archived !== undefined) p.archivedAt = patch.archived ? this.d.now() : null;
    if (!(await this.d.store.update(userId, id, p))) throw notFound('找不到这个会话');
    return this.getJson(userId, id);
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!(await this.d.store.update(userId, id, { readAt: this.d.now() }))) throw notFound('找不到这个会话');
  }

  async messages(userId: string, id: string, q: { limit: number; afterSeq?: number; beforeSeq?: number }) {
    // 两个方向只能选一个（阶段 2 预审：以前同时给时 beforeSeq 被悄悄忽略）
    if (q.afterSeq !== undefined && q.beforeSeq !== undefined) throw new HttpError(400, 'BAD_REQUEST', 'afterSeq 和 beforeSeq 只能给一个');
    await this.get(userId, id);
    const rows = await this.d.store.messages(userId, id, { ...q, limit: q.limit + 1 });
    // afterSeq 往后翻：多取的一条在末尾；往前（默认）：多取的一条在开头
    const more = rows.length > q.limit;
    const page = !more ? rows : q.afterSeq !== undefined ? rows.slice(0, q.limit) : rows.slice(1);
    return { messages: page.map(messageJson), hasMore: more };
  }

  /** 聊天流落库：只追加。会话不是本账号的聊天会话 → null（调用方当作没找到） */
  async append(userId: string, conversationId: string, role: ChatMessage['role'], content: string, meta: ChatMessageMeta | null = null): Promise<ChatMessage | null> {
    const text = clip(content, CONTENT_MAX);
    if (!text.trim()) return null;
    return this.d.store.append(userId, { id: randomUUID(), conversationId, userId, role, content: text, meta, createdAt: this.d.now() });
  }

  /**
   * 一次性导入浏览器本机的旧会话（前端只对所有者做）：按会话 id 幂等，已导入的跳过；本机那份前端不删。
   * 回复带 imported 标记（不是 Core 写的，来自本机）；助手草稿卡不导入（本机那份还在）。
   */
  async importLocal(userId: string, list: ImportInput[]) {
    let imported = 0;
    let skipped = 0;
    const ids: Record<string, string> = {};
    for (const c of list) {
      const base = this.d.now().getTime();
      const msgs: ChatMessage[] = c.messages
        .filter((m) => m.content.trim())
        .map((m, i) => ({
          id: randomUUID(),
          conversationId: c.id,
          userId,
          role: m.role,
          content: clip(m.content, CONTENT_MAX),
          meta: m.role === 'assistant' ? { imported: true } : null,
          createdAt: new Date(m.at && m.at > 0 && m.at <= base ? m.at : Math.min(c.updatedAt ?? base, base) - (c.messages.length - i)),
        }));
      if (!msgs.length) {
        skipped++;
        continue;
      }
      const at = c.updatedAt && c.updatedAt > 0 && c.updatedAt <= base ? new Date(c.updatedAt) : msgs[msgs.length - 1]!.createdAt;
      const r = await this.create(userId, { id: c.id, ...(c.title ? { title: c.title } : {}), model: c.model && MODEL_RE.test(c.model) ? c.model : 'aroomo', ...(c.group ? { group: c.group } : {}) }, msgs, at);
      if (r.created) imported++;
      else skipped++;
      ids[c.id] = r.conversation.id;
    }
    return { imported, skipped, ids };
  }
}
