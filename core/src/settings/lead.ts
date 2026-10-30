/**
 * 负责人（PRODUCT §9.3、§9.1「负责人资格」、D31：没有 @ 时交给负责人）。
 * - 只有合格的成员能当负责人：在职、启用、能文字对话、上下文 ≥32k、支持工具调用（由后端判定，见 members/caps.ts）。
 * - 用户在设置「负责人」里从合格成员里选一个；没选、或选的人不再合格时，自动用第一个合格的成员（先看置顶，再按排序）。
 * - 没有任何合格成员时没有负责人：对话里不 @ 的消息会提示先让合格的模型入职，或用 @ 直接点名。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest } from '../http/errors.js';
import { leadEligibility } from '../members/caps.js';
import type { Member, MemberStore } from '../members/types.js';
import type { SettingsStore } from './store.js';

const KEY = 'lead';

export interface LeadState {
  /** 用户选的负责人（可能为空） */
  leadId: string | null;
  /** 实际生效的负责人（自动兜底后的结果）；没有任何合格成员时为空 */
  effectiveLeadId: string | null;
  /** 生效的负责人是不是自动选的 */
  auto: boolean;
}

/** 在职、启用、未删除的成员（能被点名的人），按置顶、排序 */
export function activeMembers(all: Member[]): Member[] {
  return all
    .filter((m) => !m.deletedAt && m.enabled && m.status === 'active')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function eligibleLeads(all: Member[]): Member[] {
  return activeMembers(all).filter((m) => leadEligibility(m).eligible);
}

export class LeadService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly members: MemberStore,
    private readonly now: () => Date,
  ) {}

  async get(): Promise<LeadState> {
    const chosen = (await this.settings.get<{ memberId: string | null }>(KEY))?.memberId ?? null;
    const ok = eligibleLeads(await this.members.listAll());
    if (chosen && ok.some((m) => m.id === chosen)) return { leadId: chosen, effectiveLeadId: chosen, auto: false };
    return { leadId: chosen, effectiveLeadId: ok[0]?.id ?? null, auto: true };
  }

  async set(memberId: string | null, audit: AuditFn): Promise<LeadState> {
    if (memberId !== null) {
      const m = await this.members.get(memberId);
      if (!m || m.deletedAt) throw badRequest('找不到这个成员', 'MEMBER_NOT_FOUND');
      if (!m.enabled) throw badRequest('这个成员已停用，不能当负责人', 'MEMBER_DISABLED');
      const e = leadEligibility(m);
      if (!e.eligible) throw badRequest(`这个成员不能当负责人：${e.reason}`, 'LEAD_NOT_ELIGIBLE');
    }
    await this.settings.set(KEY, { memberId }, this.now());
    await audit('settings.lead', { type: 'member', id: memberId ?? '-' }, 'ok');
    return this.get();
  }
}
