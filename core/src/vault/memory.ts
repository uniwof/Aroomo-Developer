import { NameTakenError, type SecretRecord, type VaultStore } from './types.js';
import type { SealedSecret } from './crypto.js';

export class MemoryVaultStore implements VaultStore {
  readonly #m = new Map<string, SecretRecord>();

  async list(userId: string): Promise<SecretRecord[]> {
    return [...this.#m.values()]
      .filter((r) => r.userId === userId && !r.deletedAt)
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(userId: string, id: string): Promise<SecretRecord | null> {
    const r = this.#m.get(id);
    return r && r.userId === userId && !r.deletedAt ? { ...r } : null;
  }
  async insert(rec: SecretRecord): Promise<void> {
    for (const r of this.#m.values()) {
      if (r.userId === rec.userId && !r.deletedAt && r.name.toLowerCase() === rec.name.toLowerCase()) throw new NameTakenError();
    }
    this.#m.set(rec.id, { ...rec });
  }
  async replace(userId: string, id: string, sealed: SealedSecret, last4: string, at: Date): Promise<boolean> {
    const r = this.#m.get(id);
    if (!r || r.userId !== userId || r.deletedAt) return false;
    this.#m.set(id, { ...r, ...sealed, last4, updatedAt: at, rotatedAt: at });
    return true;
  }
  async erase(userId: string, id: string, at: Date): Promise<boolean> {
    const r = this.#m.get(id);
    if (!r || r.userId !== userId || r.deletedAt) return false;
    this.#m.set(id, { ...r, ciphertext: '', dekWrapped: '', nonce: '', last4: '', deletedAt: at, updatedAt: at });
    return true;
  }
  async countAll(): Promise<number> {
    return this.#m.size;
  }
  async countLive(): Promise<number> {
    return [...this.#m.values()].filter((r) => !r.deletedAt).length;
  }
}
