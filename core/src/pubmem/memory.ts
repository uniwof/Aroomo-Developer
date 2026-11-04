import type { MemoryEntry, MemoryVersion, PubMemStore } from './types.js';
import { KEEP_VERSIONS } from './types.js';

export class MemoryPubMemStore implements PubMemStore {
  readonly #cur = new Map<string, MemoryEntry>();
  readonly #hist = new Map<string, MemoryVersion[]>();
  #k = (u: string, t: string) => `${u}\u0000${t}`;

  async list(userId: string): Promise<MemoryEntry[]> {
    return [...this.#cur.entries()]
      .filter(([k]) => k.startsWith(`${userId}\u0000`))
      .map(([, v]) => ({ ...v }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }
  async get(userId: string, topic: string): Promise<MemoryEntry | null> {
    const e = this.#cur.get(this.#k(userId, topic));
    return e ? { ...e } : null;
  }
  async put(userId: string, topic: string, title: string, body: string, at: Date): Promise<MemoryEntry> {
    const key = this.#k(userId, topic);
    const prev = this.#cur.get(key);
    const next: MemoryEntry = { topic, title, body, version: (prev?.version ?? 0) + 1, createdAt: prev?.createdAt ?? at, updatedAt: at };
    const h = this.#hist.get(key) ?? [];
    if (prev) h.push({ topic, version: prev.version, title: prev.title, body: prev.body, createdAt: prev.updatedAt });
    this.#hist.set(key, h.slice(-KEEP_VERSIONS));
    this.#cur.set(key, next);
    return { ...next };
  }
  async versions(userId: string, topic: string): Promise<MemoryVersion[]> {
    return [...(this.#hist.get(this.#k(userId, topic)) ?? [])].sort((a, b) => b.version - a.version);
  }
  async delete(userId: string, topic: string): Promise<boolean> {
    this.#hist.delete(this.#k(userId, topic));
    return this.#cur.delete(this.#k(userId, topic));
  }
}
