import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { systemScoped, userScoped } from '../db/scope.js';
import { OWNER_SCOPE, sameSet } from './memory.js';
import { type CapabilityTag, type MemberStatus, type ModelCaps, DuplicateIdError, DuplicateNameError, InvalidOrderError, type Member, type MemberStore } from './types.js';

interface Row {
  id: string;
  name: string;
  aliases: string[];
  capability_tags: string[];
  enabled: boolean;
  pinned: boolean;
  sort_order: number;
  status: string;
  model_caps: ModelCaps | string | null;
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
  status: (r.status === 'candidate' ? 'candidate' : 'active') as MemberStatus,
  modelCaps: typeof r.model_caps === 'string' ? (JSON.parse(r.model_caps) as ModelCaps) : (r.model_caps ?? null),
  deletedAt: toDateOrNull(r.deleted_at),
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});

const capsJson = (c: ModelCaps | null) => (c ? JSON.stringify(c) : null);

function mapUnique(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505') {
    const which = `${e.constraint ?? ''} ${e.message ?? ''}`;
    if (which.includes('members_name_active_uq')) throw new DuplicateNameError();
    throw new DuplicateIdError();
  }
  throw err;
}

const COLS = 'id, name, aliases, capability_tags, enabled, pinned, sort_order, status, model_caps, deleted_at, created_at, updated_at';

export class PgMemberStore implements MemberStore {
  /** 本用户范围的连接：每个事务开头设置 app.user_id（D206 RLS） */
  private readonly db: Db;

  constructor(
    private readonly raw: Db,
    private readonly userId: string = OWNER_SCOPE,
  ) {
    this.db = userScoped(raw, userId);
  }

  forUser(userId: string): MemberStore {
    return new PgMemberStore(this.raw, userId);
  }
  /** 跨用户：只给系统定时任务列出有成员的用户（systemScoped） */
  async userIds(): Promise<string[]> {
    const { rows } = await systemScoped(this.raw).query<{ user_id: string }>('SELECT DISTINCT user_id FROM members ORDER BY user_id');
    return rows.map((r) => r.user_id);
  }

  async listAll(): Promise<Member[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM members WHERE user_id = $1`, [this.userId]);
    return rows.map(toMember);
  }
  async get(id: string): Promise<Member | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM members WHERE user_id = $1 AND id = $2`, [this.userId, id]);
    return rows[0] ? toMember(rows[0]) : null;
  }
  async insert(m: Member): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO members (user_id, ${COLS}) VALUES ($13,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [m.id, m.name, m.aliases, m.capabilityTags, m.enabled, m.pinned, m.sortOrder, m.status, capsJson(m.modelCaps), m.deletedAt, m.createdAt, m.updatedAt, this.userId],
      );
    } catch (err) {
      mapUnique(err);
    }
  }
  async update(m: Member): Promise<void> {
    try {
      await this.db.query(
        `UPDATE members SET name=$2, aliases=$3, capability_tags=$4, enabled=$5, pinned=$6, sort_order=$7, status=$8, model_caps=$9::jsonb, deleted_at=$10, updated_at=$11 WHERE id=$1 AND user_id=$12`,
        [m.id, m.name, m.aliases, m.capabilityTags, m.enabled, m.pinned, m.sortOrder, m.status, capsJson(m.modelCaps), m.deletedAt, m.updatedAt, this.userId],
      );
    } catch (err) {
      mapUnique(err);
    }
  }
  async delete(id: string): Promise<boolean> {
    const { rows } = await this.db.query('DELETE FROM members WHERE user_id = $1 AND id = $2 RETURNING id', [this.userId, id]);
    return rows.length > 0;
  }
  async reorder(ids: string[], now: Date): Promise<void> {
    await this.db.tx(async (q) => {
      // 锁住全部未删除成员，校验集合与更新在同一事务里完成
      const { rows } = await q.query<{ id: string }>('SELECT id FROM members WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE', [this.userId]);
      if (!sameSet(ids, rows.map((r) => r.id))) throw new InvalidOrderError();
      await q.query(
        `UPDATE members m SET sort_order = o.ord - 1, updated_at = $2
           FROM unnest($1::text[]) WITH ORDINALITY AS o(id, ord)
          WHERE m.user_id = $3 AND m.id = o.id`,
        [ids, now, this.userId],
      );
    });
  }
}
