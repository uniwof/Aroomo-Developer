import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import type { ClientScope, ClientTokenRecord, ClientTokenStore } from './types.js';

interface Row {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string[];
  rate_limit_per_min: number;
  created_at: unknown;
  expires_at: unknown;
  last_used_at: unknown;
  revoked_at: unknown;
}
const toRec = (r: Row): ClientTokenRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  tokenHash: r.token_hash,
  scopes: r.scopes as ClientScope[],
  rateLimitPerMin: Number(r.rate_limit_per_min),
  createdAt: toDate(r.created_at),
  expiresAt: toDateOrNull(r.expires_at),
  lastUsedAt: toDateOrNull(r.last_used_at),
  revokedAt: toDateOrNull(r.revoked_at),
});

export class PgClientTokenStore implements ClientTokenStore {
  constructor(private readonly db: Db) {}
  async insert(r: ClientTokenRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO client_tokens (id, user_id, name, token_hash, scopes, rate_limit_per_min, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, r.userId, r.name, r.tokenHash, r.scopes, r.rateLimitPerMin, r.createdAt, r.expiresAt],
    );
  }
  async getByHash(tokenHash: string): Promise<ClientTokenRecord | null> {
    const { rows } = await this.db.query<Row>('SELECT * FROM client_tokens WHERE token_hash = $1', [tokenHash]);
    return rows[0] ? toRec(rows[0]) : null;
  }
  async listByUser(userId: string): Promise<ClientTokenRecord[]> {
    const { rows } = await this.db.query<Row>('SELECT * FROM client_tokens WHERE user_id = $1 ORDER BY created_at, id', [userId]);
    return rows.map(toRec);
  }
  async revoke(userId: string, id: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      'UPDATE client_tokens SET revoked_at = COALESCE(revoked_at, $3) WHERE user_id = $1 AND id = $2 RETURNING id',
      [userId, id, at],
    );
    return rows.length > 0;
  }
  async revokeAll(userId: string, at: Date): Promise<number> {
    const { rows } = await this.db.query('UPDATE client_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId, at]);
    return rows.length;
  }
  async touch(id: string, at: Date): Promise<void> {
    await this.db.query('UPDATE client_tokens SET last_used_at = $2 WHERE id = $1', [id, at]);
  }
}
