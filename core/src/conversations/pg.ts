/**
 * PostgreSQL 实现。每个方法都在 userScoped 事务里（app.user_id = 账号，D206 RLS），SQL 里也照样带 user_id（双保险）。
 * 只认 kind = 'chat'：助手会话的 id 在这里当作不存在。不用 systemScoped。
 */
import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { userScoped } from '../db/scope.js';
import type { ChatConversation, ChatMessage, ChatMessageMeta, ConversationStore, ConversationSummary, CreateResult, ListQuery, SearchHit } from './types.js';

type Ts = Date | string;
interface CRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  group_names: string[] | null;
  read_at: Ts | null;
  archived_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}
interface MRow {
  id: string;
  seq: string | number;
  conversation_id: string;
  user_id: string;
  role: ChatMessage['role'];
  content: string;
  meta: ChatMessageMeta | string | null;
  created_at: Ts;
}
const C_COLS = 'c.id, c.user_id, c.title, c.model, c.group_names, c.read_at, c.archived_at, c.created_at, c.updated_at';
const M_COLS = 'id, seq, conversation_id, user_id, role, content, meta, created_at';

const toConv = (r: CRow): ChatConversation => ({
  id: r.id,
  userId: r.user_id,
  title: r.title,
  model: r.model,
  groupNames: r.group_names ?? [],
  readAt: toDateOrNull(r.read_at),
  archivedAt: toDateOrNull(r.archived_at),
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});
const toMsg = (r: MRow): ChatMessage => ({
  id: r.id,
  seq: Number(r.seq),
  conversationId: r.conversation_id,
  userId: r.user_id,
  role: r.role,
  content: r.content,
  meta: typeof r.meta === 'string' ? (JSON.parse(r.meta) as ChatMessageMeta) : r.meta,
  createdAt: toDate(r.created_at),
});

const INSERT_MSG = `INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, meta, created_at)
  SELECT $1, $2, $3, $4, $5, $6::jsonb, $7
  WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $2 AND user_id = $3 AND kind = 'chat' AND deleted_at IS NULL)
  RETURNING ${M_COLS}`;
const MSG_BATCH = 500;
const msgParams = (userId: string, conversationId: string, m: ChatMessage) => [m.id, conversationId, userId, m.role, m.content, m.meta ? JSON.stringify(m.meta) : null, m.createdAt];

export class PgConversationStore implements ConversationStore {
  constructor(private readonly db: Db) {}

  #u(userId: string): Db {
    return userScoped(this.db, userId);
  }

  async list(userId: string, q: ListQuery): Promise<ConversationSummary[]> {
    const { rows } = await this.#u(userId).query<CRow & { last_role: ChatMessage['role'] | null; last_content: string | null; last_at: Ts | null; n: number; unread: boolean }>(
      `SELECT * FROM (
         SELECT ${C_COLS}, l.role AS last_role, l.content AS last_content, l.created_at AS last_at,
           (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id) AS n,
           EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id AND m.role = 'assistant'
                    AND (c.read_at IS NULL OR m.created_at > c.read_at)) AS unread
         FROM conversations c
         LEFT JOIN LATERAL (SELECT role, left(content, 300) AS content, created_at FROM conversation_messages m
                             WHERE m.conversation_id = c.id AND m.user_id = c.user_id ORDER BY seq DESC LIMIT 1) l ON true
         WHERE c.user_id = $1 AND c.kind = 'chat' AND c.deleted_at IS NULL AND (c.archived_at IS NOT NULL) = $2
           AND ($3::uuid[] IS NULL OR c.id = ANY($3::uuid[]))
           AND ($4::timestamptz IS NULL OR (c.updated_at, c.id) < ($4::timestamptz, $5::uuid))
       ) s
       WHERE NOT $6::boolean OR s.unread
       ORDER BY s.updated_at DESC, s.id DESC LIMIT $7`,
      [userId, q.archived, q.ids ?? null, q.before?.updatedAt ?? null, q.before?.id ?? null, q.unreadOnly, q.limit],
    );
    return rows.map((r) => ({
      conversation: toConv(r),
      unread: r.unread,
      messageCount: Number(r.n),
      last: r.last_role ? { role: r.last_role, content: r.last_content ?? '', createdAt: toDate(r.last_at!) } : null,
    }));
  }

  async get(userId: string, id: string): Promise<ChatConversation | null> {
    const { rows } = await this.#u(userId).query<CRow>(`SELECT ${C_COLS} FROM conversations c WHERE c.id = $1 AND c.user_id = $2 AND c.kind = 'chat' AND c.deleted_at IS NULL`, [id, userId]);
    return rows[0] ? toConv(rows[0]) : null;
  }

  async create(userId: string, c: ChatConversation, messages: ChatMessage[] = []): Promise<CreateResult> {
    return this.#u(userId).tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO conversations (id, user_id, kind, title, model, group_names, read_at, created_at, updated_at)
         VALUES ($1,$2,'chat',$3,$4,$5::text[],$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [c.id, userId, c.title, c.model, c.groupNames, c.readAt, c.createdAt, c.updatedAt],
      );
      if (!rows[0]) {
        const own = await q.query<{ id: string }>(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND kind = 'chat'`, [c.id, userId]);
        return own.rows[0] ? 'exists' : 'conflict';
      }
      // 多行一次插（会话刚在同一个事务里建好，不用再逐条查它在不在）；每批 MSG_BATCH 行，参数个数远低于 PG 上限 65535
      for (let i = 0; i < messages.length; i += MSG_BATCH) {
        const batch = messages.slice(i, i + MSG_BATCH);
        const values = batch.map((_, j) => `($${j * 7 + 1},$${j * 7 + 2},$${j * 7 + 3},$${j * 7 + 4},$${j * 7 + 5},$${j * 7 + 6}::jsonb,$${j * 7 + 7})`).join(',');
        await q.query(`INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES ${values}`, batch.flatMap((m) => msgParams(userId, c.id, m)));
      }
      return 'ok';
    });
  }

  async update(userId: string, id: string, patch: Partial<Pick<ChatConversation, 'title' | 'archivedAt' | 'readAt'>>): Promise<ChatConversation | null> {
    const sets: string[] = [];
    const params: unknown[] = [id, userId];
    const col = { title: 'title', archivedAt: 'archived_at', readAt: 'read_at' } as const;
    for (const k of Object.keys(col) as (keyof typeof col)[]) {
      if (!(k in patch)) continue;
      params.push(patch[k] ?? null);
      sets.push(`${col[k]} = $${params.length}`);
    }
    if (!sets.length) return this.get(userId, id);
    const { rows } = await this.#u(userId).query<CRow>(
      `UPDATE conversations c SET ${sets.join(', ')} WHERE c.id = $1 AND c.user_id = $2 AND c.kind = 'chat' AND c.deleted_at IS NULL RETURNING ${C_COLS}`,
      params,
    );
    return rows[0] ? toConv(rows[0]) : null;
  }

  async append(userId: string, m: ChatMessage): Promise<ChatMessage | null> {
    return this.#u(userId).tx(async (q) => {
      const { rows } = await q.query<MRow>(INSERT_MSG, msgParams(userId, m.conversationId, m));
      if (!rows[0]) return null;
      await q.query(`UPDATE conversations SET updated_at = GREATEST(updated_at, $3) WHERE id = $1 AND user_id = $2`, [m.conversationId, userId, m.createdAt]);
      return toMsg(rows[0]);
    });
  }

  async messages(userId: string, conversationId: string, q: { limit: number; afterSeq?: number; beforeSeq?: number }): Promise<ChatMessage[]> {
    const own = `conversation_id = $1 AND user_id = $2 AND EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND kind = 'chat' AND deleted_at IS NULL)`;
    if (q.afterSeq !== undefined) {
      const { rows } = await this.#u(userId).query<MRow>(`SELECT ${M_COLS} FROM conversation_messages WHERE ${own} AND seq > $3 ORDER BY seq LIMIT $4`, [conversationId, userId, q.afterSeq, q.limit]);
      return rows.map(toMsg);
    }
    const { rows } = await this.#u(userId).query<MRow>(
      `SELECT * FROM (SELECT ${M_COLS} FROM conversation_messages WHERE ${own} AND ($3::bigint IS NULL OR seq < $3) ORDER BY seq DESC LIMIT $4) x ORDER BY seq`,
      [conversationId, userId, q.beforeSeq ?? null, q.limit],
    );
    return rows.map(toMsg);
  }

  async search(userId: string, q: { text: string; limit: number; beforeSeq?: number }): Promise<SearchHit[]> {
    // shortcut: 顺序扫描本账号的消息（家庭规模够快）；单账号几十万条时加 pg_trgm GIN 索引（要装扩展、定 locale，见 design-search-compaction-v1 §1）
    const like = `%${q.text.replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await this.#u(userId).query<MRow & { title: string }>(
      `SELECT m.id, m.seq, m.conversation_id, m.user_id, m.role, m.content, m.meta, m.created_at, c.title
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
       WHERE m.user_id = $1 AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.archived_at IS NULL
         AND m.role IN ('user', 'assistant') AND m.content ILIKE $2 ESCAPE '\\'
         AND ($3::bigint IS NULL OR m.seq < $3)
       ORDER BY m.seq DESC LIMIT $4`,
      [userId, like, q.beforeSeq ?? null, q.limit],
    );
    return rows.map((r) => ({ message: toMsg(r), title: r.title }));
  }

  async latestSummary(userId: string, conversationId: string): Promise<ChatMessage | null> {
    const { rows } = await this.#u(userId).query<MRow>(
      `SELECT ${M_COLS} FROM conversation_messages WHERE conversation_id = $1 AND user_id = $2 AND role = 'system' AND meta ? 'summary' ORDER BY seq DESC LIMIT 1`,
      [conversationId, userId],
    );
    return rows[0] ? toMsg(rows[0]) : null;
  }

  async countSummariesSince(userId: string, since: Date): Promise<number> {
    const { rows } = await this.#u(userId).query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM conversation_messages WHERE user_id = $1 AND role = 'system' AND meta ? 'summary' AND created_at >= $2`,
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
