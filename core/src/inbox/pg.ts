import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import {
  INBOX_GROUPS,
  type InboxAction,
  type InboxGroup,
  type InboxItem,
  type InboxListFilter,
  type InboxStatus,
  type InboxStore,
  type Urgency,
} from './types.js';

interface Row {
  id: string;
  grp: InboxGroup;
  kind: string;
  urgency: Urgency;
  title: string;
  summary: string;
  related_type: string | null;
  related_id: string | null;
  actions: InboxAction[] | string;
  status: InboxStatus;
  created_at: Date | string;
  resolved_at: Date | string | null;
  resolved_action: string | null;
}

const COLS = 'id, grp, kind, urgency, title, summary, related_type, related_id, actions, status, created_at, resolved_at, resolved_action';

function toItem(r: Row): InboxItem {
  const resolvedAt = toDateOrNull(r.resolved_at);
  return {
    id: r.id,
    group: r.grp,
    kind: r.kind,
    urgency: r.urgency,
    title: r.title,
    summary: r.summary,
    ...(r.related_type !== null && r.related_id !== null ? { related: { type: r.related_type, id: r.related_id } } : {}),
    actions: typeof r.actions === 'string' ? (JSON.parse(r.actions) as InboxAction[]) : r.actions,
    status: r.status,
    createdAt: toDate(r.created_at),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(r.resolved_action !== null ? { resolvedAction: r.resolved_action } : {}),
  };
}

const ORDER = `ORDER BY (status = 'open') DESC,
  CASE urgency WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
  created_at DESC, id`;

export class PgInboxStore implements InboxStore {
  constructor(private readonly db: Db) {}

  async insertDedup(item: InboxItem): Promise<{ item: InboxItem; created: boolean }> {
    const params = [
      item.id,
      item.group,
      item.kind,
      item.urgency,
      item.title,
      item.summary,
      item.related?.type ?? null,
      item.related?.id ?? null,
      JSON.stringify(item.actions),
      item.status,
      item.createdAt,
    ];
    const ins = await this.db.query<Row>(
      `INSERT INTO inbox_items (id, grp, kind, urgency, title, summary, related_type, related_id, actions, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (kind, related_type, related_id) WHERE status = 'open' AND related_type IS NOT NULL DO NOTHING
       RETURNING ${COLS}`,
      params,
    );
    if (ins.rows[0]) return { item: toItem(ins.rows[0]), created: true };
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLS} FROM inbox_items WHERE status = 'open' AND kind = $1 AND related_type = $2 AND related_id = $3`,
      [item.kind, item.related?.type ?? null, item.related?.id ?? null],
    );
    if (!rows[0]) throw new Error('inbox dedup race: conflicting open item vanished');
    return { item: toItem(rows[0]), created: false };
  }

  async get(id: string): Promise<InboxItem | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM inbox_items WHERE id = $1`, [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async list(f: InboxListFilter): Promise<InboxItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.group) {
      params.push(f.group);
      where.push(`grp = $${params.length}`);
    }
    if (f.status) {
      params.push(f.status);
      where.push(`status = $${params.length}`);
    }
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLS} FROM inbox_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER}`,
      params,
    );
    return rows.map(toItem);
  }

  async openCounts(): Promise<Record<InboxGroup, number>> {
    const { rows } = await this.db.query<{ grp: InboxGroup; n: string }>(
      `SELECT grp, count(*)::text AS n FROM inbox_items WHERE status = 'open' GROUP BY grp`,
    );
    const out = Object.fromEntries(INBOX_GROUPS.map((g) => [g, 0])) as Record<InboxGroup, number>;
    for (const r of rows) out[r.grp] = Number(r.n);
    return out;
  }

  async resolveIfOpen(
    id: string,
    next: { status: Exclude<InboxStatus, 'open'>; resolvedAt: Date; resolvedAction?: string },
  ): Promise<InboxItem | null> {
    const { rows } = await this.db.query<Row>(
      `UPDATE inbox_items SET status = $2, resolved_at = $3, resolved_action = $4
        WHERE id = $1 AND status = 'open' RETURNING ${COLS}`,
      [id, next.status, next.resolvedAt, next.resolvedAction ?? null],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }
}
