import type { Db } from '../db/db.js';
import { toDate } from '../db/db.js';
import { userScoped } from '../db/scope.js';
import { KEEP_VERSIONS, type MemoryEntry, type MemoryVersion, type PubMemStore } from './types.js';

interface Row {
  topic: string;
  title: string;
  body: string;
  version: number;
  created_at: unknown;
  updated_at: unknown;
}
const toEntry = (r: Row): MemoryEntry => ({
  topic: r.topic,
  title: r.title,
  body: r.body,
  version: Number(r.version),
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});

export class PgPubMemStore implements PubMemStore {
  constructor(private readonly db: Db) {}

  /** D206：每次访问都在设置了 app.user_id 的事务里（RLS 兜底），WHERE user_id 保留作双保险 */
  #as(userId: string): Db {
    return userScoped(this.db, userId);
  }

  async list(userId: string): Promise<MemoryEntry[]> {
    const { rows } = await this.#as(userId).query<Row>('SELECT * FROM public_memory WHERE user_id = $1 ORDER BY topic', [userId]);
    return rows.map(toEntry);
  }
  async get(userId: string, topic: string): Promise<MemoryEntry | null> {
    const { rows } = await this.#as(userId).query<Row>('SELECT * FROM public_memory WHERE user_id = $1 AND topic = $2', [userId, topic]);
    return rows[0] ? toEntry(rows[0]) : null;
  }
  async put(userId: string, topic: string, title: string, body: string, at: Date): Promise<MemoryEntry> {
    return this.#as(userId).tx(async (q) => {
      const { rows: cur } = await q.query<Row>('SELECT * FROM public_memory WHERE user_id = $1 AND topic = $2 FOR UPDATE', [userId, topic]);
      if (cur[0]) {
        await q.query(
          `INSERT INTO public_memory_versions (user_id, topic, version, title, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId, topic, cur[0].version, cur[0].title, cur[0].body, toDate(cur[0].updated_at)],
        );
        await q.query(
          `DELETE FROM public_memory_versions WHERE user_id = $1 AND topic = $2 AND version <= $3`,
          [userId, topic, Number(cur[0].version) - KEEP_VERSIONS],
        );
        const { rows } = await q.query<Row>(
          `UPDATE public_memory SET title=$3, body=$4, version=version+1, updated_at=$5 WHERE user_id=$1 AND topic=$2 RETURNING *`,
          [userId, topic, title, body, at],
        );
        return toEntry(rows[0] as Row);
      }
      const { rows } = await q.query<Row>(
        `INSERT INTO public_memory (user_id, topic, title, body, version, created_at, updated_at) VALUES ($1,$2,$3,$4,1,$5,$5) RETURNING *`,
        [userId, topic, title, body, at],
      );
      return toEntry(rows[0] as Row);
    });
  }
  async versions(userId: string, topic: string): Promise<MemoryVersion[]> {
    const { rows } = await this.#as(userId).query<Row & { created_at: unknown }>(
      'SELECT topic, version, title, body, created_at FROM public_memory_versions WHERE user_id = $1 AND topic = $2 ORDER BY version DESC',
      [userId, topic],
    );
    return rows.map((r) => ({ topic: r.topic, version: Number(r.version), title: r.title, body: r.body, createdAt: toDate(r.created_at) }));
  }
  async delete(userId: string, topic: string): Promise<boolean> {
    return this.#as(userId).tx(async (q) => {
      await q.query('DELETE FROM public_memory_versions WHERE user_id = $1 AND topic = $2', [userId, topic]);
      const { rows } = await q.query('DELETE FROM public_memory WHERE user_id = $1 AND topic = $2 RETURNING topic', [userId, topic]);
      return rows.length > 0;
    });
  }
}
