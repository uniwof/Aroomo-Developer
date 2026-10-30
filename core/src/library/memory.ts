import type { LibraryItem, LibraryKind, LibraryStore } from './types.js';
import { scoreItem } from './types.js';

export class MemoryLibraryStore implements LibraryStore {
  readonly #items = new Map<string, LibraryItem & { userId: string }>();

  async add(userId: string, item: LibraryItem) {
    if (item.url) {
      const dup = [...this.#items.values()].find((i) => i.userId === userId && i.url === item.url);
      if (dup) return { item: { ...dup }, existed: true };
    }
    this.#items.set(item.id, { ...item, userId });
    return { item: { ...item }, existed: false };
  }
  async get(userId: string, id: string) {
    const i = this.#items.get(id);
    return i && i.userId === userId ? { ...i } : null;
  }
  #mine(userId: string, kind?: LibraryKind) {
    return [...this.#items.values()].filter((i) => i.userId === userId && (!kind || i.kind === kind));
  }
  async list(userId: string, opts: { kind?: LibraryKind; limit: number }) {
    return this.#mine(userId, opts.kind)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit)
      .map((i) => ({ ...i }));
  }
  async search(userId: string, terms: string[], opts: { kind?: LibraryKind; limit: number }) {
    return this.#mine(userId, opts.kind)
      .map((i) => ({ i, s: scoreItem(i, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.i.createdAt.getTime() - a.i.createdAt.getTime())
      .slice(0, opts.limit)
      .map((x) => ({ ...x.i }));
  }
  async delete(userId: string, id: string) {
    const i = this.#items.get(id);
    if (!i || i.userId !== userId) return false;
    return this.#items.delete(id);
  }
}
