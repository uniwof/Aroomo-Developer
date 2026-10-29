import type { Db } from '../db/db.js';
import { toDate } from '../db/db.js';
import type { SealedSecret } from './crypto.js';
import { NameTakenError, type SecretKind, type SecretRecord, type VaultStore } from './types.js';

interface Row {
  id: string;
  user_id: string;
  name: string;
  kind: SecretKind;
  last4: string;
  ciphertext: string;
  dek_wrapped: string;
  nonce: string;
  created_at: unknown;
  updated_at: unknown;
  rotated_at: unknown;
  deleted_at: unknown;
}
const toRec = (r: Row): SecretRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  kind: r.kind,
  last4: r.last4,
  ciphertext: r.ciphertext,
  dekWrapped: r.dek_wrapped,
  nonce: r.nonce,
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
  rotatedAt: r.rotated_at ? toDate(r.rotated_at) : null,
  deletedAt: r.deleted_at ? toDate(r.deleted_at) : null,
});

export class PgVaultStore implements VaultStore {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<SecretRecord[]> {
    const { rows } = await this.db.query<Row>('SELECT * FROM vault_secrets WHERE user_id = $1 AND deleted_at IS NULL ORDER BY lower(name)', [userId]);
    return rows.map(toRec);
  }
  async get(userId: string, id: string): Promise<SecretRecord | null> {
    const { rows } = await this.db.query<Row>('SELECT * FROM vault_secrets WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL', [userId, id]);
    return rows[0] ? toRec(rows[0]) : null;
  }
  async insert(r: SecretRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO vault_secrets (id, user_id, name, kind, last4, ciphertext, dek_wrapped, nonce, created_at, updated_at, rotated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL)`,
        [r.id, r.userId, r.name, r.kind, r.last4, r.ciphertext, r.dekWrapped, r.nonce, r.createdAt, r.updatedAt],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new NameTakenError();
      throw err;
    }
  }
  async replace(userId: string, id: string, s: SealedSecret, last4: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE vault_secrets SET ciphertext=$3, dek_wrapped=$4, nonce=$5, last4=$6, updated_at=$7, rotated_at=$7
       WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`,
      [userId, id, s.ciphertext, s.dekWrapped, s.nonce, last4, at],
    );
    return rows.length > 0;
  }
  async erase(userId: string, id: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE vault_secrets SET ciphertext='', dek_wrapped='', nonce='', last4='', deleted_at=$3, updated_at=$3
       WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`,
      [userId, id, at],
    );
    return rows.length > 0;
  }
  async countAll(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_secrets');
    return Number(rows[0]?.n ?? 0);
  }
  async countLive(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_secrets WHERE deleted_at IS NULL');
    return Number(rows[0]?.n ?? 0);
  }
}
