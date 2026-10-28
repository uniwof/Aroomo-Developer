import { DuplicateIdError, DuplicateNameError, InvalidOrderError, type Member, type MemberStore } from './types.js';

const clone = (m: Member): Member => ({
  ...m,
  aliases: [...m.aliases],
  capabilityTags: [...m.capabilityTags],
  modelCaps: m.modelCaps ? { ...m.modelCaps } : null,
  deletedAt: m.deletedAt ? new Date(m.deletedAt) : null,
  createdAt: new Date(m.createdAt),
  updatedAt: new Date(m.updatedAt),
});

export class MemoryMemberStore implements MemberStore {
  readonly #rows = new Map<string, Member>();

  #nameTaken(name: string, exceptId: string): boolean {
    const lower = name.toLowerCase();
    for (const r of this.#rows.values()) {
      if (r.id !== exceptId && r.deletedAt === null && r.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  async listAll(): Promise<Member[]> {
    return [...this.#rows.values()].map(clone);
  }
  async get(id: string): Promise<Member | null> {
    const r = this.#rows.get(id);
    return r ? clone(r) : null;
  }
  async insert(m: Member): Promise<void> {
    if (this.#rows.has(m.id)) throw new DuplicateIdError();
    if (m.deletedAt === null && this.#nameTaken(m.name, m.id)) throw new DuplicateNameError();
    this.#rows.set(m.id, clone(m));
  }
  async update(m: Member): Promise<void> {
    if (!this.#rows.has(m.id)) return;
    if (m.deletedAt === null && this.#nameTaken(m.name, m.id)) throw new DuplicateNameError();
    this.#rows.set(m.id, clone(m));
  }
  async delete(id: string): Promise<boolean> {
    return this.#rows.delete(id);
  }
  async reorder(ids: string[], now: Date): Promise<void> {
    const active = [...this.#rows.values()].filter((r) => r.deletedAt === null);
    if (!sameSet(ids, active.map((r) => r.id))) throw new InvalidOrderError();
    ids.forEach((id, idx) => {
      const r = this.#rows.get(id) as Member;
      this.#rows.set(id, { ...r, sortOrder: idx, updatedAt: new Date(now) });
    });
  }
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  if (sa.size !== a.length) return false;
  return b.every((x) => sa.has(x));
}
