import type { ClientTokenRecord, ClientTokenStore } from './types.js';

export class MemoryClientTokenStore implements ClientTokenStore {
  readonly #rows = new Map<string, ClientTokenRecord>();
  async insert(r: ClientTokenRecord): Promise<void> {
    this.#rows.set(r.id, { ...r, scopes: [...r.scopes] });
  }
  async getByHash(tokenHash: string): Promise<ClientTokenRecord | null> {
    for (const r of this.#rows.values()) if (r.tokenHash === tokenHash) return { ...r, scopes: [...r.scopes] };
    return null;
  }
  async listByUser(userId: string): Promise<ClientTokenRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r, scopes: [...r.scopes] }));
  }
  async revoke(userId: string, id: string, at: Date): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || r.userId !== userId) return false;
    if (!r.revokedAt) r.revokedAt = at;
    return true;
  }
  async revokeAll(userId: string, at: Date): Promise<number> {
    let n = 0;
    for (const r of this.#rows.values()) {
      if (r.userId === userId && !r.revokedAt) {
        r.revokedAt = at;
        n++;
      }
    }
    return n;
  }
  async touch(id: string, at: Date): Promise<void> {
    const r = this.#rows.get(id);
    if (r) r.lastUsedAt = at;
  }
}
