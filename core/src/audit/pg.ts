import type { Queryable } from '../db/db.js';
import { toDate } from '../db/db.js';
import { clampLimit, decodeCursor, encodeCursor, freezeEntry, InvalidCursorError, newEntryId, sanitize } from './common.js';
import type { AuditEntry, AuditInput, AuditLog, AuditPage, AuditQuery, AuditResult, ActorType } from './types.js';

interface DbRow {
  seq_text: string;
  id: string;
  ts: Date | string;
  actor_type: ActorType;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  result: AuditResult;
  note: string | null;
}

function toEntry(r: DbRow): AuditEntry {
  return freezeEntry({
    id: r.id,
    ts: toDate(r.ts),
    actor: { type: r.actor_type, id: r.actor_id },
    action: r.action,
    target: { type: r.target_type, id: r.target_id },
    result: r.result,
    ...(r.note !== null ? { note: r.note } : {}),
  });
}

const COLS = 'seq::text AS seq_text, id, ts, actor_type, actor_id, action, target_type, target_id, result, note';

/** PostgreSQL 实现。表上有触发器禁止 UPDATE / DELETE / TRUNCATE（migrations/0001_audit_log.sql）。 */
export class PgAuditLog implements AuditLog {
  readonly #db: Queryable;
  readonly #now: () => Date;

  constructor(db: Queryable, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    Object.freeze(this);
  }

  async append(input: AuditInput): Promise<AuditEntry> {
    const c = sanitize(input);
    const { rows } = await this.#db.query<DbRow>(
      `INSERT INTO audit_log (id, ts, actor_type, actor_id, action, target_type, target_id, result, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [newEntryId(), this.#now(), c.actor.type, c.actor.id, c.action, c.target.type, c.target.id, c.result, c.note ?? null],
    );
    return toEntry(rows[0] as DbRow);
  }

  async query(q: AuditQuery = {}): Promise<AuditPage> {
    const limit = clampLimit(q.limit);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.cursor !== undefined) {
      const c = decodeCursor(q.cursor);
      if (c === null) throw new InvalidCursorError();
      add('seq < ?', c);
    }
    if (q.actor?.type) add('actor_type = ?', q.actor.type);
    if (q.actor?.id) add('actor_id = ?', q.actor.id);
    if (q.action) add('action = ?', q.action);
    if (q.target?.type) add('target_type = ?', q.target.type);
    if (q.target?.id) add('target_id = ?', q.target.id);
    if (q.from) add('ts >= ?', q.from);
    if (q.to) add('ts < ?', q.to);
    params.push(limit + 1);
    const { rows } = await this.#db.query<DbRow>(
      `SELECT ${COLS} FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY audit_log.seq DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { entries: page.map(toEntry), nextCursor: hasMore && last ? encodeCursor(last.seq_text) : null };
  }
}
