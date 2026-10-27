import {
  CAPABILITY_TAGS,
  type AuditFn,
  type CreateMemberInput,
  type Member,
  type MemberStore,
  type UpdateMemberInput,
} from './types.js';

export class MemberServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'MemberServiceError';
  }
}

export interface MemberServiceOptions {
  store: MemberStore;
  audit?: AuditFn;
}

const MEMBER_ID_REGEX = /^[a-z0-9-]+$/;

export class MemberService {
  private store: MemberStore;
  private audit?: AuditFn;

  constructor(options: MemberServiceOptions) {
    this.store = options.store;
    this.audit = options.audit;
  }

  private async logAudit(
    action: string,
    target: string,
    result: 'success' | 'failure',
    details?: Record<string, unknown>,
  ) {
    if (this.audit) {
      await this.audit(action, target, result, details);
    }
  }

  private validateId(id: string) {
    if (!id || typeof id !== 'string' || !MEMBER_ID_REGEX.test(id)) {
      throw new MemberServiceError(
        'Invalid member id. Allowed characters: [a-z0-9-]',
        400,
      );
    }
  }

  private validateName(name: string) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new MemberServiceError('Member name cannot be empty', 400);
    }
  }

  private validateCapabilityTags(tags?: string[]) {
    if (!tags) return;
    if (!Array.isArray(tags)) {
      throw new MemberServiceError('capabilityTags must be an array', 400);
    }
    const validTags = new Set<string>(CAPABILITY_TAGS);
    for (const tag of tags) {
      if (!validTags.has(tag)) {
        throw new MemberServiceError(
          `Invalid capabilityTag '${tag}'. Allowed: ${CAPABILITY_TAGS.join(', ')}`,
          400,
        );
      }
    }
  }

  async list(options?: { includeDeleted?: boolean }): Promise<Member[]> {
    return this.store.list(options);
  }

  async getById(id: string): Promise<Member> {
    const member = await this.store.findById(id);
    if (!member) {
      throw new MemberServiceError(`Member with id '${id}' not found`, 404);
    }
    return member;
  }

  async create(input: CreateMemberInput): Promise<Member> {
    this.validateId(input.id);
    this.validateName(input.name);
    this.validateCapabilityTags(input.capabilityTags);

    const existingById = await this.store.findById(input.id);
    if (existingById) {
      await this.logAudit('member.create', input.id, 'failure', {
        reason: 'ID already exists',
      });
      throw new MemberServiceError(
        `Member with id '${input.id}' already exists`,
        409,
      );
    }

    const trimmedName = input.name.trim();
    const existingByName = await this.store.findByName(trimmedName);
    if (existingByName) {
      await this.logAudit('member.create', input.id, 'failure', {
        reason: 'Name already exists',
      });
      throw new MemberServiceError(
        `Member with name '${trimmedName}' already exists (case-insensitive)`,
        409,
      );
    }

    try {
      const created = await this.store.create({
        ...input,
        name: trimmedName,
      });
      await this.logAudit('member.create', created.id, 'success', {
        name: created.name,
      });
      return created;
    } catch (err) {
      await this.logAudit('member.create', input.id, 'failure', {
        error: String(err),
      });
      throw err;
    }
  }

  async update(id: string, input: UpdateMemberInput): Promise<Member> {
    const existing = await this.getById(id);

    if (input.name !== undefined) {
      this.validateName(input.name);
      const trimmedName = input.name.trim();
      if (trimmedName.toLowerCase() !== existing.name.toLowerCase()) {
        const existingByName = await this.store.findByName(trimmedName);
        if (existingByName && existingByName.id !== id) {
          await this.logAudit('member.update', id, 'failure', {
            reason: 'Name already exists',
          });
          throw new MemberServiceError(
            `Member with name '${trimmedName}' already exists (case-insensitive)`,
            409,
          );
        }
      }
      input = { ...input, name: trimmedName };
    }

    if (input.capabilityTags !== undefined) {
      this.validateCapabilityTags(input.capabilityTags);
    }

    try {
      const updated = await this.store.update(id, input);
      if (!updated) {
        throw new MemberServiceError(`Member with id '${id}' not found`, 404);
      }
      await this.logAudit('member.update', id, 'success', { changes: input });
      return updated;
    } catch (err) {
      if (!(err instanceof MemberServiceError)) {
        await this.logAudit('member.update', id, 'failure', {
          error: String(err),
        });
      }
      throw err;
    }
  }

  async softDelete(id: string): Promise<Member> {
    await this.getById(id);
    try {
      const deleted = await this.store.softDelete(id);
      if (!deleted) {
        throw new MemberServiceError(`Member with id '${id}' not found`, 404);
      }
      await this.logAudit('member.delete', id, 'success');
      return deleted;
    } catch (err) {
      if (!(err instanceof MemberServiceError)) {
        await this.logAudit('member.delete', id, 'failure', {
          error: String(err),
        });
      }
      throw err;
    }
  }

  async restore(id: string): Promise<Member> {
    try {
      const restored = await this.store.restore(id);
      if (!restored) {
        await this.logAudit('member.restore', id, 'failure', {
          reason: 'Not found or deleted over 30 days',
        });
        throw new MemberServiceError(
          `Member with id '${id}' not found or deleted over 30 days ago`,
          404,
        );
      }
      await this.logAudit('member.restore', id, 'success');
      return restored;
    } catch (err) {
      if (!(err instanceof MemberServiceError)) {
        await this.logAudit('member.restore', id, 'failure', {
          error: String(err),
        });
      }
      throw err;
    }
  }

  async purge(id: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      await this.logAudit('member.purge', id, 'failure', {
        reason: 'confirm is not true',
      });
      throw new MemberServiceError(
        'Hard delete requires confirm: true in request body',
        409,
      );
    }

    const success = await this.store.purge(id);
    if (!success) {
      await this.logAudit('member.purge', id, 'failure', {
        reason: 'Not found',
      });
      throw new MemberServiceError(`Member with id '${id}' not found`, 404);
    }

    await this.logAudit('member.purge', id, 'success');
  }

  async setPinned(id: string, pinned: boolean): Promise<Member> {
    await this.getById(id);
    const action = pinned ? 'member.pin' : 'member.unpin';
    try {
      const updated = await this.store.setPinned(id, pinned);
      if (!updated) {
        throw new MemberServiceError(`Member with id '${id}' not found`, 404);
      }
      await this.logAudit(action, id, 'success', { pinned });
      return updated;
    } catch (err) {
      if (!(err instanceof MemberServiceError)) {
        await this.logAudit(action, id, 'failure', { error: String(err) });
      }
      throw err;
    }
  }

  async reorder(ids: string[]): Promise<Member[]> {
    if (!Array.isArray(ids)) {
      throw new MemberServiceError('Reorder input must be an array of ids', 400);
    }

    try {
      const reordered = await this.store.reorder(ids);
      await this.logAudit('member.reorder', ids.join(','), 'success', { ids });
      return reordered;
    } catch (err) {
      await this.logAudit('member.reorder', ids.join(','), 'failure', {
        error: String(err),
      });
      if (err instanceof Error) {
        throw new MemberServiceError(err.message, 400);
      }
      throw err;
    }
  }
}
