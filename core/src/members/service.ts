/**
 * 成员业务规则（Issue #5）：
 * - 列表：置顶在前，再按 sortOrder、创建时间；默认不含已删除；回收站只显示 30 天内删除的。
 * - 删除 = 软删除进回收站；撤销删除；彻底删除是不可逆操作，走统一确认服务的重要确认（D63），且只能删回收站里的。
 * - 名字非空、大小写不敏感去重；id 只允许 [a-z0-9-]；别名不能与其他成员的名字/别名冲突（会让点名有歧义）。
 * - 每个写操作都写审计（成功 ok；业务拒绝 failed 并带错误码）。
 */
import { randomBytes } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { type ConfirmCtx, ConfirmService, MemoryChallengeStore } from '../confirm/confirm.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import {
  CAPABILITY_TAGS,
  type CapabilityTag,
  DuplicateIdError,
  DuplicateNameError,
  InvalidOrderError,
  type Member,
  MEMBER_ID_RE,
  type MemberStore,
  RECYCLE_MS,
} from './types.js';

export interface CreateMemberInput {
  id?: string;
  name: string;
  aliases?: string[];
  capabilityTags?: CapabilityTag[];
  enabled?: boolean;
}

export interface UpdateMemberInput {
  name?: string;
  aliases?: string[];
  capabilityTags?: CapabilityTag[];
  enabled?: boolean;
}

export function compareMembers(a: Member, b: Member): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
}

export class MembersService {
  constructor(
    private readonly store: MemberStore,
    private readonly now: () => Date,
    private readonly confirm: ConfirmService = new ConfirmService(new MemoryChallengeStore(), { now }),
  ) {}

  #inBin(m: Member, now: Date): boolean {
    return m.deletedAt !== null && now.getTime() - m.deletedAt.getTime() < RECYCLE_MS;
  }

  async list(opts: { deleted?: boolean } = {}): Promise<Member[]> {
    const now = this.now();
    const all = await this.store.listAll();
    if (opts.deleted) {
      return all
        .filter((m) => this.#inBin(m, now))
        .sort((a, b) => (b.deletedAt as Date).getTime() - (a.deletedAt as Date).getTime());
    }
    return all.filter((m) => m.deletedAt === null).sort(compareMembers);
  }

  async create(input: CreateMemberInput, audit: AuditFn): Promise<Member> {
    return this.#audited(audit, 'members.create', input.id ?? input.name, async () => {
      const name = normalizeName(input.name);
      const aliases = normalizeAliases(input.aliases ?? [], name);
      const tags = normalizeTags(input.capabilityTags ?? []);
      const all = await this.store.listAll();
      let id: string;
      if (input.id !== undefined) {
        if (!MEMBER_ID_RE.test(input.id)) throw badRequest('id 只能包含小写字母、数字和 -（1–64 位）', 'INVALID_ID');
        id = input.id;
      } else {
        id = this.#freeId(slugify(name) || `member-${randomBytes(3).toString('hex')}`, all);
      }
      this.#checkAliasConflicts(id, name, aliases, all);
      const now = this.now();
      const maxOrder = all.filter((m) => m.deletedAt === null).reduce((mx, m) => Math.max(mx, m.sortOrder), -1);
      const m: Member = {
        id,
        name,
        aliases,
        capabilityTags: tags,
        enabled: input.enabled ?? true,
        pinned: false,
        sortOrder: maxOrder + 1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.#write(() => this.store.insert(m));
      return m;
    });
  }

  async update(id: string, patch: UpdateMemberInput, audit: AuditFn): Promise<Member> {
    return this.#audited(audit, 'members.update', id, async () => {
      const m = await this.#getActive(id);
      const name = patch.name !== undefined ? normalizeName(patch.name) : m.name;
      const aliases = patch.aliases !== undefined ? normalizeAliases(patch.aliases, name) : m.aliases;
      const tags = patch.capabilityTags !== undefined ? normalizeTags(patch.capabilityTags) : m.capabilityTags;
      this.#checkAliasConflicts(id, name, aliases, await this.store.listAll());
      const next: Member = { ...m, name, aliases, capabilityTags: tags, enabled: patch.enabled ?? m.enabled, updatedAt: this.now() };
      await this.#write(() => this.store.update(next));
      return next;
    });
  }

  async softDelete(id: string, audit: AuditFn): Promise<Member> {
    return this.#audited(audit, 'members.delete', id, async () => {
      const m = await this.#getActive(id);
      const now = this.now();
      const next: Member = { ...m, pinned: false, deletedAt: now, updatedAt: now };
      await this.store.update(next);
      return next;
    });
  }

  async restore(id: string, audit: AuditFn): Promise<Member> {
    return this.#audited(audit, 'members.restore', id, async () => {
      const m = await this.store.get(id);
      const now = this.now();
      if (!m || !this.#inBin(m, now)) throw notFound('回收站里没有这个成员（可能已超过 30 天）');
      const all = await this.store.listAll();
      const maxOrder = all.filter((x) => x.deletedAt === null).reduce((mx, x) => Math.max(mx, x.sortOrder), -1);
      const next: Member = { ...m, deletedAt: null, sortOrder: maxOrder + 1, updatedAt: now };
      this.#checkAliasConflicts(id, next.name, next.aliases, all);
      await this.#write(() => this.store.update(next));
      return next;
    });
  }

  /** 彻底删除：不可逆，重要确认（D63）；只能删回收站里的成员。 */
  async purge(id: string, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    await this.#audited(audit, 'members.purge', id, async () => {
      const m = await this.store.get(id);
      if (!m) throw notFound('找不到这个成员');
      if (m.deletedAt === null) throw conflict('请先删除（移入回收站）再彻底删除', 'NOT_IN_RECYCLE_BIN');
      await this.confirm.require(
        {
          scope: `members:purge:${id}`,
          kind: 'irreversible',
          title: `彻底删除成员「${m.name}」`,
          consequences: ['成员会被永久删除，不能从回收站恢复。', '它的名字和别名之后可以给别的成员使用。'],
          confirmLabel: '彻底删除',
        },
        ctx,
        audit,
      );
      await this.store.delete(id);
    });
  }

  async setPinned(id: string, pinned: boolean, audit: AuditFn): Promise<Member> {
    return this.#audited(audit, pinned ? 'members.pin' : 'members.unpin', id, async () => {
      const m = await this.#getActive(id);
      const next: Member = { ...m, pinned, updatedAt: this.now() };
      await this.store.update(next);
      return next;
    });
  }

  async reorder(ids: string[], audit: AuditFn): Promise<Member[]> {
    return this.#audited(audit, 'members.reorder', `${ids.length} members`, async () => {
      try {
        await this.store.reorder(ids, this.now());
      } catch (err) {
        if (err instanceof InvalidOrderError) throw badRequest(err.message, 'INVALID_ORDER');
        throw err;
      }
      return this.list();
    });
  }

  /** 清理回收站里超过 30 天的成员（供定时任务调用），返回清理的 id。 */
  async sweepExpired(audit: AuditFn): Promise<string[]> {
    const now = this.now();
    const expired = (await this.store.listAll()).filter((m) => m.deletedAt !== null && !this.#inBin(m, now));
    for (const m of expired) {
      await this.store.delete(m.id);
      await audit('members.purge_expired', { type: 'member', id: m.id }, 'ok');
    }
    return expired.map((m) => m.id);
  }

  async #getActive(id: string): Promise<Member> {
    const m = await this.store.get(id);
    if (!m || m.deletedAt !== null) throw notFound('找不到这个成员');
    return m;
  }

  #freeId(base: string, all: Member[]): string {
    const taken = new Set(all.map((m) => m.id));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i += 1) {
      const c = `${base}-${i}`;
      if (!taken.has(c)) return c;
    }
  }

  #checkAliasConflicts(id: string, name: string, aliases: string[], all: Member[]): void {
    const mine = [name, ...aliases].map((s) => s.toLowerCase());
    for (const o of all) {
      if (o.id === id || o.deletedAt !== null) continue;
      const theirs = new Set([o.name, ...o.aliases].map((s) => s.toLowerCase()));
      // 名字与名字的冲突交给存储层的唯一索引报 DUPLICATE_NAME；这里只管涉及别名的冲突
      if (theirs.has(name.toLowerCase()) && o.name.toLowerCase() !== name.toLowerCase()) {
        throw conflict(`名字与成员「${o.name}」的别名冲突`, 'ALIAS_CONFLICT');
      }
      for (const a of mine.slice(1)) {
        if (theirs.has(a)) throw conflict(`别名「${a}」与成员「${o.name}」冲突`, 'ALIAS_CONFLICT');
      }
    }
  }

  async #write(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof DuplicateNameError) throw conflict('已有同名成员（不区分大小写）', 'DUPLICATE_NAME');
      if (err instanceof DuplicateIdError) throw conflict('成员 id 已存在', 'DUPLICATE_ID');
      throw err;
    }
  }

  async #audited<T>(audit: AuditFn, action: string, targetId: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      const id = (out as { id?: string } | undefined)?.id ?? targetId;
      await audit(action, { type: 'member', id }, 'ok');
      return out;
    } catch (err) {
      // 428 = 请确认，不是失败（确认服务已记 confirm.requested）
      if (err instanceof HttpError && err.code !== 'CONFIRM_REQUIRED') await audit(action, { type: 'member', id: targetId }, 'failed', err.code);
      throw err;
    }
  }
}

function normalizeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('名字不能为空', 'INVALID_NAME');
  if (name.length > 128) throw badRequest('名字最长 128 个字符', 'INVALID_NAME');
  return name;
}

function normalizeAliases(raw: string[], name: string): string[] {
  const seen = new Set<string>([name.toLowerCase()]);
  const out: string[] = [];
  for (const a of raw) {
    const t = a.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 64) throw badRequest('别名最长 64 个字符', 'INVALID_ALIAS');
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  if (out.length > 20) throw badRequest('别名最多 20 个', 'INVALID_ALIAS');
  return out;
}

function normalizeTags(raw: string[]): CapabilityTag[] {
  const out: CapabilityTag[] = [];
  for (const t of raw) {
    if (!(CAPABILITY_TAGS as readonly string[]).includes(t)) throw badRequest(`未知能力标签「${t}」`, 'INVALID_TAG');
    if (!out.includes(t as CapabilityTag)) out.push(t as CapabilityTag);
  }
  return out;
}
