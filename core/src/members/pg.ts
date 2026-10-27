import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { sameSet } from './memory.js';
import { type CapabilityTag, DuplicateIdError, DuplicateNameError, InvalidOrderError, type Member, type MemberStore } from './types.js';

interface Row {
  id: string;
  name: string;
  aliases: string[];
  capability_tags: string[];
  enabled: boolean;
  pinned: boolean;
  sort_order: number;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toMember = (r: Row): Member => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases ?? [],
  capabilityTags: (r.capability_tags ?? []) as CapabilityTag[],
  enabled: r.enabled,
  pinned: r.pinned,
  sortOrder: Number(r.sort_order),
  deletedAt: toDateOrNull(r.deleted_at),
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});

function mapUnique(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505') {
    const which = `${e.constraint ?? ''} ${e.message ?? ''}`;
    if (which.includes('members_name_active_uq')) throw new DuplicateNameError();
    throw new DuplicateIdError();
  }
  throw err;
}

const COLS = 'id, name, aliases, capability_tags, enabled, pinned, sort_order, deleted_at, created_at, updated_at';

export class PgMemberStore implements MemberStore {
  constructor(private readonly db: Db) {}

  async listAll(): Promise<Member[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM members`);
    return rows.map(toMember);
  }
  async get(id: string): Promise<Member | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM members WHERE id = $1`, [id]);
    return rows[0] ? toMember(rows[0]) : null;
  }
  async insert(m: Member): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO members (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [m.id, m.name, m.aliases, m.capabilityTags, m.enabled, m.pinned, m.sortOrder, m.deletedAt, m.createdAt, m.updatedAt],
      );
    } catch (err) {
      mapUnique(err);
    }
  }
  async update(m: Member): Promise<void> {
    try {
      await this.db.query(
        `UPDATE members SET name=$2, aliases=$3, capability_tags=$4, enabled=$5, pinned=$6, sort_order=$7, deleted_at=$8, updated_at=$9 WHERE id=$1`,
        [m.id, m.name, m.aliases, m.capabilityTags, m.enabled, m.pinned, m.sortOrder, m.deletedAt, m.updatedAt],
      );
    } catch (err) {
      mapUnique(err);
    }
  }
  async delete(id: string): Promise<boolean> {
    const { rows } = await this.db.query('DELETE FROM members WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }
  async reorder(ids: string[], now: Date): Promise<void> {
    await this.db.tx(async (q) => {
      // 锁住全部未删除成员，校验集合与更新在同一事务里完成
      const { rows } = await q.query<{ id: string }>('SELECT id FROM members WHERE deleted_at IS NULL FOR UPDATE');
      if (!sameSet(ids, rows.map((r) => r.id))) throw new InvalidOrderError();
      await q.query(
        `UPDATE members m SET sort_order = o.ord - 1, updated_at = $2
           FROM unnest($1::text[]) WITH ORDINALITY AS o(id, ord)
          WHERE m.id = o.id`,
        [ids, now],
      );
    });
  }
}
