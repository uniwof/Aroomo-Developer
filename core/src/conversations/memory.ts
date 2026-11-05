/** 内存实现（测试、没配数据库时）。和 PG 实现同一套语义：只看本账号、只追加。 */
import type { ChatConversation, ChatMessage, ConversationStore, ConversationSummary, CreateResult, ListQuery } from './types.js';

const cloneC = (c: ChatConversation): ChatConversation => ({ ...c, groupNames: [...c.groupNames] });
const cloneM = (m: ChatMessage): ChatMessage => ({ ...m, meta: m.meta ? structuredClone(m.meta) : null });

export class MemoryConversationStore implements ConversationStore {
  readonly #convs = new Map<string, ChatConversation>();
  readonly #messages: ChatMessage[] = [];
  #seq = 0;

  #own(userId: string, id: string): ChatConversation | null {
    const c = this.#convs.get(id);
    return c && c.userId === userId ? c : null;
  }

  async list(userId: string, q: ListQuery): Promise<ConversationSummary[]> {
    const ids = q.ids ? new Set(q.ids) : null;
    const rows = [...this.#convs.values()]
      .filter((c) => c.userId === userId && (q.archived ? c.archivedAt !== null : c.archivedAt === null) && (!ids || ids.has(c.id)))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter((c) => !q.before || c.updatedAt.getTime() < q.before.updatedAt.getTime() || (c.updatedAt.getTime() === q.before.updatedAt.getTime() && c.id < q.before.id))
      .map((c) => {
        const ms = this.#messages.filter((m) => m.conversationId === c.id);
        const last = ms.at(-1);
        const unread = ms.some((m) => m.role !== 'user' && (!c.readAt || m.createdAt.getTime() > c.readAt.getTime()));
        return { conversation: cloneC(c), unread, messageCount: ms.length, last: last ? { role: last.role, content: last.content, createdAt: last.createdAt } : null };
      })
      .filter((s) => !q.unreadOnly || s.unread);
    return rows.slice(0, q.limit);
  }

  async get(userId: string, id: string): Promise<ChatConversation | null> {
    const c = this.#own(userId, id);
    return c ? cloneC(c) : null;
  }

  async create(userId: string, c: ChatConversation, messages: ChatMessage[] = []): Promise<CreateResult> {
    const had = this.#convs.get(c.id);
    if (had) return had.userId === userId ? 'exists' : 'conflict';
    this.#convs.set(c.id, cloneC({ ...c, userId }));
    for (const m of messages) this.#messages.push({ ...cloneM(m), userId, conversationId: c.id, seq: ++this.#seq });
    return 'ok';
  }

  async update(userId: string, id: string, patch: Partial<Pick<ChatConversation, 'title' | 'archivedAt' | 'readAt'>>): Promise<ChatConversation | null> {
    const c = this.#own(userId, id);
    if (!c) return null;
    Object.assign(c, patch);
    return cloneC(c);
  }

  async append(userId: string, m: ChatMessage): Promise<ChatMessage | null> {
    const c = this.#own(userId, m.conversationId);
    if (!c || m.userId !== userId) return null;
    const row = { ...cloneM(m), seq: ++this.#seq };
    this.#messages.push(row);
    c.updatedAt = new Date(m.createdAt);
    return cloneM(row);
  }

  async messages(userId: string, conversationId: string, q: { limit: number; afterSeq?: number; beforeSeq?: number }): Promise<ChatMessage[]> {
    if (!this.#own(userId, conversationId)) return [];
    const all = this.#messages.filter((m) => m.conversationId === conversationId && m.userId === userId);
    if (q.afterSeq !== undefined) return all.filter((m) => m.seq! > q.afterSeq!).slice(0, q.limit).map(cloneM);
    const before = q.beforeSeq;
    return all.filter((m) => before === undefined || m.seq! < before).slice(-q.limit).map(cloneM);
  }
}
