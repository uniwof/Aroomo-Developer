import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { EmailTakenError, type InviteRecord, type SessionRecord, type UserPatch, type UserRecord, type UserRole, type UserStatus, type UserStore } from './types.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  password_hash: string;
  created_at: unknown;
  updated_at: unknown;
}
interface InviteRow {
  token_hash: string;
  kind: 'invite' | 'reset';
  email: string;
  user_id: string | null;
  role: UserRole;
  created_by: string;
  created_at: unknown;
  expires_at: unknown;
  used_at: unknown;
}
interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  status: r.status,
  passwordHash: r.password_hash,
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});
const toInvite = (r: InviteRow): InviteRecord => ({
  tokenHash: r.token_hash,
  kind: r.kind,
  email: r.email,
  userId: r.user_id,
  role: r.role,
  createdBy: r.created_by,
  createdAt: toDate(r.created_at),
  expiresAt: toDate(r.expires_at),
  usedAt: toDateOrNull(r.used_at),
});
const toSession = (r: SessionRow): SessionRecord => ({
  tokenHash: r.token_hash,
  userId: r.user_id,
  createdAt: toDate(r.created_at),
  expiresAt: toDate(r.expires_at),
  revokedAt: toDateOrNull(r.revoked_at),
});

export class PgUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  async insertUser(u: UserRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.id, u.email, u.displayName, u.role, u.status, u.passwordHash, u.createdAt, u.updatedAt],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new EmailTakenError();
      throw err;
    }
  }
  async getUser(id: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users ORDER BY created_at, id');
    return rows.map(toUser);
  }
  async updateUser(id: string, patch: UserPatch, at: Date): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>(
      `UPDATE users SET
         display_name  = COALESCE($2, display_name),
         role          = COALESCE($3, role),
         status        = COALESCE($4, status),
         password_hash = COALESCE($5, password_hash),
         updated_at    = $6
       WHERE id = $1 RETURNING *`,
      [id, patch.displayName ?? null, patch.role ?? null, patch.status ?? null, patch.passwordHash ?? null, at],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }
  async insertInvite(i: InviteRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO user_invites (token_hash, kind, email, user_id, role, created_by, created_at, expires_at, used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)`,
      [i.tokenHash, i.kind, i.email, i.userId, i.role, i.createdBy, i.createdAt, i.expiresAt],
    );
  }
  async useInvite(tokenHash: string, at: Date): Promise<InviteRecord | null> {
    const { rows } = await this.db.query<InviteRow>(
      `UPDATE user_invites SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *`,
      [tokenHash, at],
    );
    return rows[0] ? toInvite(rows[0]) : null;
  }
  async listOpenInvites(at: Date): Promise<InviteRecord[]> {
    const { rows } = await this.db.query<InviteRow>(
      'SELECT * FROM user_invites WHERE used_at IS NULL AND expires_at > $1 ORDER BY created_at',
      [at],
    );
    return rows.map(toInvite);
  }
  async insertSession(s: SessionRecord): Promise<void> {
    await this.db.query('INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,NULL)', [
      s.tokenHash,
      s.userId,
      s.createdAt,
      s.expiresAt,
    ]);
  }
  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const { rows } = await this.db.query<SessionRow>('SELECT * FROM user_sessions WHERE token_hash = $1', [tokenHash]);
    return rows[0] ? toSession(rows[0]) : null;
  }
  async revokeSession(tokenHash: string, at: Date): Promise<void> {
    await this.db.query('UPDATE user_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash, at]);
  }
  async revokeUserSessions(userId: string, at: Date, exceptTokenHash?: string): Promise<void> {
    await this.db.query(
      `UPDATE user_sessions SET revoked_at = $2
       WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR token_hash <> $3)`,
      [userId, at, exceptTokenHash ?? null],
    );
  }
}
