import type { Db } from '../db/db.js';
import { toDate } from '../db/db.js';
import { userScoped } from '../db/scope.js';
import type { LibraryItem, LibraryKind, LibraryStore } from './types.js';

interface Row {
  id: string;
  kind: LibraryKind;
  title: string;
  url: string | null;
  body: string;
  tags: string;
  source: string;
  created_at: unknown;
  updated_at: unknown;
}
const toItem = (r: Row): LibraryItem => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  url: r.url,
  body: r.body,
  tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
  source: r.source,
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PgLibraryStore implements LibraryStore {
  constructor(private readonly db: Db) {}

  /** D206：每次访问都在设置了 app.user_id 的事务里（RLS 兜底），WHERE user_id 保留作双保险 */
  #as(userId: string): Db {
    return userScoped(this.db, userId);
  }

  async add(userId: string, it: LibraryItem) {
    const { rows } = await this.#as(userId).query<Row>(
      `INSERT INTO library_items (id, user_id, kind, title, url, body, tags, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (user_id, url) WHERE url IS NOT NULL DO NOTHING
       RETURNING *`,
      [it.id, userId, it.kind, it.title, it.url, it.body, it.tags.join(','), it.source, it.createdAt],
    );
    if (rows[0]) return { item: toItem(rows[0]), existed: false };
    const { rows: old } = await this.#as(userId).query<Row>('SELECT * FROM library_items WHERE user_id = $1 AND url = $2', [userId, it.url]);
    return { item: toItem(old[0] as Row), existed: true };
  }
  async get(userId: string, id: string) {
    const { rows } = await this.#as(userId).query<Row>('SELECT * FROM library_items WHERE user_id = $1 AND id = $2', [userId, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }
  async list(userId: string, opts: { kind?: LibraryKind; limit: number }) {
    const { rows } = await this.#as(userId).query<Row>(
      `SELECT * FROM library_items WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC LIMIT $3`,
      [userId, opts.kind ?? null, opts.limit],
    );
    return rows.map(toItem);
  }
  async search(userId: string, terms: string[], opts: { kind?: LibraryKind; limit: number }) {
    // 每个词都要命中；分数权重与 scoreItem 一致（标题 8 > 标签 4 > 链接 2 > 正文 1）
    const params: unknown[] = [userId, opts.kind ?? null, opts.limit];
    const where: string[] = [];
    const score: string[] = [];
    for (const term of terms) {
      params.push(`%${likeEscape(term)}%`);
      const p = `$${params.length}`;
      where.push(`(title ILIKE ${p} OR tags ILIKE ${p} OR coalesce(url,'') ILIKE ${p} OR body ILIKE ${p})`);
      score.push(`(CASE WHEN title ILIKE ${p} THEN 8 ELSE 0 END + CASE WHEN tags ILIKE ${p} THEN 4 ELSE 0 END + CASE WHEN coalesce(url,'') ILIKE ${p} THEN 2 ELSE 0 END + CASE WHEN body ILIKE ${p} THEN 1 ELSE 0 END)`);
    }
    const { rows } = await this.#as(userId).query<Row>(
      `SELECT * FROM library_items WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)${where.length ? ' AND ' + where.join(' AND ') : ''}
       ORDER BY ${score.length ? '(' + score.join(' + ') + ') DESC,' : ''} created_at DESC LIMIT $3`,
      params,
    );
    return rows.map(toItem);
  }
  async delete(userId: string, id: string) {
    const { rows } = await this.#as(userId).query('DELETE FROM library_items WHERE user_id = $1 AND id = $2 RETURNING id', [userId, id]);
    return rows.length > 0;
  }
}
