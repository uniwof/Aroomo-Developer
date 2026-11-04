/**
 * 入职流程（PRODUCT §9.1「加 Key、接入… → 自动发现模型 → 进入候选 → 用户一键入职 → 自动跑入职小考题」；
 * §8.3 成员页「候选（N）」、收件箱「候选」组；docs/ops/OLD-VS-NEW.md #50）。
 *
 * - propose：新 Key 的模型不再直接成为成员，而是建一个「候选」成员（不能被点名、不能当负责人），
 *   并在收件箱「候选」组发一张卡片：[入职] [不要]。同名成员已存在（候选或在职）时只刷新它的模型事实。
 * - onboard：候选 → 在职（成员页按钮和收件箱「入职」都走这里），收件箱里的候选卡片随之处理。
 * - reject：候选移到回收站（30 天内可恢复）。
 * - 入职小考题（§9.1 最后一步）不在本次范围，见 PROGRESS。
 */
import type { AuditFn } from '../audit/types.js';
import { notFound } from '../http/errors.js';
import type { InboxService } from '../inbox/service.js';
import type { LiteLLMAdmin } from '../keys/litellm.js';
import { capsSummary, leadEligibility, refreshModelCaps } from './caps.js';
import type { MembersService } from './service.js';
import type { Member, MemberStore } from './types.js';

export const CANDIDATE_KIND = 'member.candidate';

export class CandidateFlow {
  constructor(
    private readonly members: MembersService,
    private readonly store: MemberStore,
    private readonly inbox: InboxService,
    private readonly litellm: LiteLLMAdmin,
    private readonly now: () => Date,
  ) {
    inbox.registerHandler(CANDIDATE_KIND, async (item, actionId, audit) => {
      const id = item.related?.id;
      if (!id) return;
      if (actionId === 'onboard') await this.#onboardMember(id, audit);
      else if (actionId === 'reject') await this.#rejectMember(id, audit);
    });
  }

  async #refresh(names?: string[]): Promise<void> {
    // 拿不到模型信息不影响流程：成员照样能入职，只是暂时不能当负责人（资格判定会写明原因）
    await refreshModelCaps(this.store, this.litellm, this.now, names).catch(() => 0);
  }

  /** 新模型 → 候选 + 收件箱卡片。返回成员（已存在则返回已有成员）。 */
  async propose(modelName: string, audit: AuditFn): Promise<Member> {
    const same = (n: string) => n.toLowerCase() === modelName.toLowerCase();
    const existing = (await this.members.list()).find((m) => same(m.name));
    if (existing) {
      await this.#refresh([existing.name]);
      return (await this.store.get(existing.id)) ?? existing;
    }
    const created = await this.members.create({ name: modelName, status: 'candidate' }, audit);
    await this.#refresh([created.name]);
    const m = (await this.store.get(created.id)) ?? created;
    const lead = leadEligibility({ ...m, status: 'active' });
    await this.inbox.createInboxItem(
      {
        group: 'candidate',
        kind: CANDIDATE_KIND,
        title: `新成员候选：${m.name}`,
        summary: `${capsSummary(m.modelCaps)}${lead.eligible ? ' · 可以当负责人' : ''}`,
        related: { type: 'member', id: m.id },
        actions: [
          { id: 'onboard', label: '入职' },
          { id: 'reject', label: '不要' },
        ],
      },
      audit,
    );
    return m;
  }

  async #onboardMember(id: string, audit: AuditFn): Promise<Member> {
    const m = await this.store.get(id);
    if (!m || m.deletedAt) throw notFound('这个候选已经删除了');
    const next = await this.members.onboard(id, audit);
    await this.#refresh([next.name]);
    return (await this.store.get(id)) ?? next;
  }

  async #rejectMember(id: string, audit: AuditFn): Promise<void> {
    const m = await this.store.get(id);
    if (!m || m.deletedAt) return;
    if (m.status === 'candidate') await this.members.softDelete(id, audit);
  }

  /** 成员页「入职」按钮：入职，并把收件箱里对应的候选卡片标记为已处理。 */
  async onboard(id: string, audit: AuditFn): Promise<Member> {
    const m = await this.#onboardMember(id, audit);
    await this.inbox.resolveRelated(CANDIDATE_KIND, { type: 'member', id }, 'done', audit, 'onboard');
    return m;
  }
}
