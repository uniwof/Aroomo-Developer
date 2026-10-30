import { EmailTakenError, type InviteRecord, type SessionRecord, type UserPatch, type UserRecord, type UserStore } from './types.js';

export class MemoryUserStore implements UserStore {
  readonly #users = new Map<string, UserRecord>();
  readonly #invites = new Map<string, InviteRecord>();
  readonly #sessions = new Map<string, SessionRecord>();

  async insertUser(u: UserRecord): Promise<void> {
    const lower = u.email.toLowerCase();
    for (const x of this.#users.values()) if (x.email.toLowerCase() === lower) throw new EmailTakenError();
    this.#users.set(u.id, { ...u });
  }
  async getUser(id: string): Promise<UserRecord | null> {
    const u = this.#users.get(id);
    return u ? { ...u } : null;
  }
  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const lower = email.toLowerCase();
    for (const u of this.#users.values()) if (u.email.toLowerCase() === lower) return { ...u };
    return null;
  }
  async listUsers(): Promise<UserRecord[]> {
    return [...this.#users.values()].map((u) => ({ ...u })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async updateUser(id: string, patch: UserPatch, at: Date): Promise<UserRecord | null> {
    const u = this.#users.get(id);
    if (!u) return null;
    Object.assign(u, patch, { updatedAt: at });
    return { ...u };
  }
  async insertInvite(i: InviteRecord): Promise<void> {
    this.#invites.set(i.tokenHash, { ...i });
  }
  async useInvite(tokenHash: string, at: Date): Promise<InviteRecord | null> {
    const i = this.#invites.get(tokenHash);
    if (!i || i.usedAt || i.expiresAt.getTime() <= at.getTime()) return null;
    i.usedAt = at;
    return { ...i };
  }
  async listOpenInvites(at: Date): Promise<InviteRecord[]> {
    return [...this.#invites.values()].filter((i) => !i.usedAt && i.expiresAt.getTime() > at.getTime()).map((i) => ({ ...i }));
  }
  async insertSession(s: SessionRecord): Promise<void> {
    this.#sessions.set(s.tokenHash, { ...s });
  }
  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const s = this.#sessions.get(tokenHash);
    return s ? { ...s } : null;
  }
  async revokeSession(tokenHash: string, at: Date): Promise<void> {
    const s = this.#sessions.get(tokenHash);
    if (s && !s.revokedAt) s.revokedAt = at;
  }
  async revokeUserSessions(userId: string, at: Date, exceptTokenHash?: string): Promise<void> {
    for (const s of this.#sessions.values()) {
      if (s.userId === userId && s.tokenHash !== exceptTokenHash && !s.revokedAt) s.revokedAt = at;
    }
  }
}
