import type {
  CreateMemberInput,
  Member,
  MemberStore,
  MemberStoreOptions,
  UpdateMemberInput,
} from './types.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class InMemoryMemberStore implements MemberStore {
  private members = new Map<string, Member>();
  private getNow: () => Date;

  constructor(options?: MemberStoreOptions) {
    this.getNow = options?.getNow ?? (() => new Date());
  }

  private isExpired(deletedAt: string | null, now: Date): boolean {
    if (!deletedAt) return false;
    const deletedTime = new Date(deletedAt).getTime();
    return now.getTime() - deletedTime > THIRTY_DAYS_MS;
  }

  async list(options?: { includeDeleted?: boolean }): Promise<Member[]> {
    const now = this.getNow();
    const includeDeleted = options?.includeDeleted ?? false;
    const result: Member[] = [];

    for (const member of this.members.values()) {
      if (member.deletedAt === null) {
        result.push({ ...member });
      } else if (includeDeleted && !this.isExpired(member.deletedAt, now)) {
        result.push({ ...member });
      }
    }

    result.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return a.sortOrder - b.sortOrder;
    });

    return result;
  }

  async findById(id: string): Promise<Member | null> {
    const member = this.members.get(id);
    if (!member) return null;
    const now = this.getNow();
    if (member.deletedAt !== null && this.isExpired(member.deletedAt, now)) {
      return null;
    }
    return { ...member };
  }

  async findByName(name: string): Promise<Member | null> {
    const target = name.toLowerCase();
    const now = this.getNow();
    for (const member of this.members.values()) {
      if (member.deletedAt !== null && this.isExpired(member.deletedAt, now)) {
        continue;
      }
      if (member.name.toLowerCase() === target) {
        return { ...member };
      }
    }
    return null;
  }

  async create(input: CreateMemberInput): Promise<Member> {
    const nowIso = this.getNow().toISOString();
    let maxSortOrder = -1;
    for (const member of this.members.values()) {
      if (member.deletedAt === null && member.sortOrder > maxSortOrder) {
        maxSortOrder = member.sortOrder;
      }
    }

    const member: Member = {
      id: input.id,
      name: input.name,
      aliases: input.aliases ?? [],
      capabilityTags: input.capabilityTags ?? [],
      enabled: input.enabled ?? true,
      pinned: input.pinned ?? false,
      sortOrder: input.sortOrder ?? maxSortOrder + 1,
      deletedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.members.set(member.id, member);
    return { ...member };
  }

  async update(id: string, input: UpdateMemberInput): Promise<Member | null> {
    const existing = await this.findById(id);
    if (!existing || existing.deletedAt !== null) {
      return null;
    }

    const nowIso = this.getNow().toISOString();
    const updated: Member = {
      ...existing,
      name: input.name ?? existing.name,
      aliases: input.aliases ?? existing.aliases,
      capabilityTags: input.capabilityTags ?? existing.capabilityTags,
      enabled: input.enabled ?? existing.enabled,
      pinned: input.pinned ?? existing.pinned,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      updatedAt: nowIso,
    };

    this.members.set(id, updated);
    return { ...updated };
  }

  async softDelete(id: string): Promise<Member | null> {
    const existing = await this.findById(id);
    if (!existing || existing.deletedAt !== null) {
      return null;
    }

    const nowIso = this.getNow().toISOString();
    const deleted: Member = {
      ...existing,
      deletedAt: nowIso,
      updatedAt: nowIso,
    };

    this.members.set(id, deleted);
    return { ...deleted };
  }

  async restore(id: string): Promise<Member | null> {
    const raw = this.members.get(id);
    if (!raw || raw.deletedAt === null) {
      return null;
    }

    const now = this.getNow();
    if (this.isExpired(raw.deletedAt, now)) {
      return null;
    }

    const nowIso = now.toISOString();
    const restored: Member = {
      ...raw,
      deletedAt: null,
      updatedAt: nowIso,
    };

    this.members.set(id, restored);
    return { ...restored };
  }

  async purge(id: string): Promise<boolean> {
    const raw = this.members.get(id);
    if (!raw) {
      return false;
    }
    return this.members.delete(id);
  }

  async setPinned(id: string, pinned: boolean): Promise<Member | null> {
    return this.update(id, { pinned });
  }

  async reorder(ids: string[]): Promise<Member[]> {
    const activeMembers = Array.from(this.members.values()).filter(
      (m) => m.deletedAt === null,
    );

    if (ids.length !== activeMembers.length) {
      throw new Error('Reorder IDs count does not match active members count');
    }

    const activeSet = new Set(activeMembers.map((m) => m.id));
    const providedSet = new Set(ids);

    if (providedSet.size !== ids.length) {
      throw new Error('Reorder IDs contain duplicates');
    }

    for (const id of ids) {
      if (!activeSet.has(id)) {
        throw new Error(`Member with ID ${id} is not an active member`);
      }
    }

    const nowIso = this.getNow().toISOString();
    ids.forEach((id, index) => {
      const member = this.members.get(id)!;
      member.sortOrder = index;
      member.updatedAt = nowIso;
    });

    return this.list({ includeDeleted: false });
  }
}
