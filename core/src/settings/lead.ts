/**
 * 负责人（PRODUCT §9.3、D31：没有 @ 时交给负责人）。
 * P0：用户在设置「负责人」里选一个成员；没选或选的成员已停用 / 删除时，自动用第一个启用的成员
 * （先看置顶，再按排序），保证「填入一个 Key 后就能对话」（PRODUCT 16.1 验收）。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest } from '../http/errors.js';
import type { Member, MemberStore } from '../members/types.js';
import type { SettingsStore } from './store.js';

const KEY = 'lead';

export interface LeadState {
  /** 用户选的负责人（可能为空） */
  leadId: string | null;
  /** 实际生效的负责人（自动兜底后的结果）；没有任何启用的成员时为空 */
  effectiveLeadId: string | null;
  /** 生效的负责人是不是自动选的 */
  auto: boolean;
}

export function activeMembers(all: Member[]): Member[] {
  return all
    .filter((m) => !m.deletedAt && m.enabled)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export class LeadService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly members: MemberStore,
    private readonly now: () => Date,
  ) {}

  async get(): Promise<LeadState> {
    const chosen = (await this.settings.get<{ memberId: string | null }>(KEY))?.memberId ?? null;
    const active = activeMembers(await this.members.listAll());
    if (chosen && active.some((m) => m.id === chosen)) return { leadId: chosen, effectiveLeadId: chosen, auto: false };
    return { leadId: chosen, effectiveLeadId: active[0]?.id ?? null, auto: true };
  }

  async set(memberId: string | null, audit: AuditFn): Promise<LeadState> {
    if (memberId !== null) {
      const m = await this.members.get(memberId);
      if (!m || m.deletedAt) throw badRequest('找不到这个成员', 'MEMBER_NOT_FOUND');
      if (!m.enabled) throw badRequest('这个成员已停用，不能当负责人', 'MEMBER_DISABLED');
    }
    await this.settings.set(KEY, { memberId }, this.now());
    await audit('settings.lead', { type: 'member', id: memberId ?? '-' }, 'ok');
    return this.get();
  }
}
