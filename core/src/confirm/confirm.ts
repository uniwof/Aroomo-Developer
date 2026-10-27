/**
 * 不可逆操作的二次确认令牌（DECISIONS D50：不可逆操作二次确认并留审计记录）。
 *
 * - 第一次请求不执行，只签发一次性令牌（默认 5 分钟有效）；
 * - 带令牌的第二次请求才执行；令牌绑定「操作范围（scope）+ 操作者」，用过即作废；
 * - 只存令牌的 SHA-256，不存明文。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { conflict } from '../http/errors.js';

export const CONFIRM_TTL_MS = 5 * 60 * 1000;

export type ConsumeResult = 'ok' | 'invalid' | 'expired' | 'used';

export interface ConfirmTokenRow {
  hash: string;
  scope: string;
  actor: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface ConfirmStore {
  insert(row: ConfirmTokenRow): Promise<void>;
  /** 原子消费：只有一个并发请求能拿到 ok。 */
  consume(hash: string, scope: string, actor: string, now: Date): Promise<ConsumeResult>;
}

export class MemoryConfirmStore implements ConfirmStore {
  readonly #rows = new Map<string, ConfirmTokenRow>();
  async insert(row: ConfirmTokenRow): Promise<void> {
    this.#rows.set(row.hash, { ...row });
  }
  async consume(hash: string, scope: string, actor: string, now: Date): Promise<ConsumeResult> {
    const r = this.#rows.get(hash);
    if (!r || r.scope !== scope || r.actor !== actor) return 'invalid';
    if (r.usedAt) return 'used';
    if (r.expiresAt.getTime() <= now.getTime()) return 'expired';
    r.usedAt = new Date(now);
    return 'ok';
  }
}

export class PgConfirmStore implements ConfirmStore {
  constructor(private readonly db: Db) {}
  async insert(row: ConfirmTokenRow): Promise<void> {
    await this.db.query(
      'INSERT INTO confirm_tokens (token_hash, scope, actor, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [row.hash, row.scope, row.actor, row.createdAt, row.expiresAt],
    );
  }
  async consume(hash: string, scope: string, actor: string, now: Date): Promise<ConsumeResult> {
    const upd = await this.db.query(
      `UPDATE confirm_tokens SET used_at = $4
        WHERE token_hash = $1 AND scope = $2 AND actor = $3 AND used_at IS NULL AND expires_at > $4
        RETURNING token_hash`,
      [hash, scope, actor, now],
    );
    if (upd.rows.length > 0) return 'ok';
    const { rows } = await this.db.query<{ scope: string; actor: string; expires_at: Date; used_at: Date | null }>(
      'SELECT scope, actor, expires_at, used_at FROM confirm_tokens WHERE token_hash = $1',
      [hash],
    );
    const r = rows[0];
    if (!r || r.scope !== scope || r.actor !== actor) return 'invalid';
    if (toDateOrNull(r.used_at)) return 'used';
    if (toDate(r.expires_at).getTime() <= now.getTime()) return 'expired';
    return 'invalid';
  }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export class ConfirmService {
  constructor(
    private readonly store: ConfirmStore,
    private readonly now: () => Date,
    private readonly ttlMs = CONFIRM_TTL_MS,
  ) {}

  async issue(scope: string, actor: string): Promise<{ confirmToken: string; expiresAt: Date }> {
    const token = randomBytes(24).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    await this.store.insert({ hash: sha256(token), scope, actor, createdAt: now, expiresAt, usedAt: null });
    return { confirmToken: token, expiresAt };
  }

  /** 校验并消费令牌；失败抛 409（CONFIRM_INVALID / CONFIRM_EXPIRED / CONFIRM_USED）。 */
  async consume(token: string, scope: string, actor: string): Promise<void> {
    const r = await this.store.consume(sha256(token), scope, actor, this.now());
    if (r === 'ok') return;
    if (r === 'expired') throw conflict('确认已过期，请重新操作', 'CONFIRM_EXPIRED');
    if (r === 'used') throw conflict('这个确认已经用过了', 'CONFIRM_USED');
    throw conflict('确认无效，请重新操作', 'CONFIRM_INVALID');
  }
}
