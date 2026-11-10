import type { Db } from '../db/db.js';
import { toDate } from '../db/db.js';
import { systemScoped } from '../db/scope.js';
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

/**
 * PostgreSQL 实现。表上有触发器禁止 UPDATE / DELETE / TRUNCATE（migrations/0001_audit_log.sql）。
 * RLS（0038，#345 P2）：append 任何路径都能写（含登录失败、系统任务），所以不设范围、也不 RETURNING（RETURNING 需要 SELECT 权限）；
 * query 只给所有者的 GET /api/audit 用，走 systemScoped。
 */
export class PgAuditLog implements AuditLog {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    Object.freeze(this);
  }

  async append(input: AuditInput): Promise<AuditEntry> {
    const c = sanitize(input);
    const id = newEntryId();
    const ts = this.#now();
    await this.#db.query(
      `INSERT INTO audit_log (id, ts, actor_type, actor_id, action, target_type, target_id, result, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ts, c.actor.type, c.actor.id, c.action, c.target.type, c.target.id, c.result, c.note ?? null],
    );
    return freezeEntry({
      id,
      ts,
      actor: { type: c.actor.type, id: c.actor.id },
      action: c.action,
      target: { type: c.target.type, id: c.target.id },
      result: c.result,
      ...(c.note !== undefined ? { note: c.note } : {}),
    });
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
    const { rows } = await systemScoped(this.#db).query<DbRow>(
      `SELECT ${COLS} FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY audit_log.seq DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { entries: page.map(toEntry), nextCursor: hasMore && last ? encodeCursor(last.seq_text) : null };
  }
}
