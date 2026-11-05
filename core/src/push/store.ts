/** X-08 推送订阅的存储：内存版（开发 / 测试）和 PostgreSQL 版（0029，RLS 按 user_id）。 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import { userScoped } from '../db/scope.js';

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushSubscriptionRow extends PushSubscriptionInput {
  id: string;
  userId: string;
  createdAt: Date;
}

export interface PushStore {
  /** 同一账号同一 endpoint 只留一行（浏览器换了加密密钥就覆盖）；created=false 表示原来就有 */
  upsert(userId: string, s: PushSubscriptionInput, now: Date): Promise<{ created: boolean }>;
  remove(userId: string, endpoint: string): Promise<boolean>;
  list(userId: string): Promise<PushSubscriptionRow[]>;
}

export class MemoryPushStore implements PushStore {
  readonly #rows: PushSubscriptionRow[] = [];
  async upsert(userId: string, s: PushSubscriptionInput, now: Date): Promise<{ created: boolean }> {
    const hit = this.#rows.find((r) => r.userId === userId && r.endpoint === s.endpoint);
    if (hit) {
      Object.assign(hit, { p256dh: s.p256dh, auth: s.auth });
      return { created: false };
    }
    this.#rows.push({ id: randomUUID(), userId, ...s, createdAt: now });
    return { created: true };
  }
  async remove(userId: string, endpoint: string): Promise<boolean> {
    const i = this.#rows.findIndex((r) => r.userId === userId && r.endpoint === endpoint);
    if (i < 0) return false;
    this.#rows.splice(i, 1);
    return true;
  }
  async list(userId: string): Promise<PushSubscriptionRow[]> {
    return this.#rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }
}

interface Row {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: Date | string;
}

export class PgPushStore implements PushStore {
  constructor(private readonly db: Db) {}
  async upsert(userId: string, s: PushSubscriptionInput, now: Date): Promise<{ created: boolean }> {
    const { rows } = await userScoped(this.db, userId).query<{ created: boolean }>(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
       RETURNING (xmax = 0) AS created`,
      [randomUUID(), userId, s.endpoint, s.p256dh, s.auth, now],
    );
    return { created: rows[0]?.created === true };
  }
  async remove(userId: string, endpoint: string): Promise<boolean> {
    const { rows } = await userScoped(this.db, userId).query<{ id: string }>(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2 RETURNING id`,
      [userId, endpoint],
    );
    return rows.length > 0;
  }
  async list(userId: string): Promise<PushSubscriptionRow[]> {
    const { rows } = await userScoped(this.db, userId).query<Row>(
      `SELECT id, user_id, endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: new Date(r.created_at) }));
  }
}
