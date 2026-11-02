/**
 * 收件箱自动收拾（M4）：没人理的低价值卡片过期，避免收件箱越堆越多。
 * - 简报（brief）3 天没看 → 过期；
 * - 低紧急度（low）且动作只有普通确认的 7 天没理 → 过期；
 * - 需要拍板的（decision 且 urgency 不是 low）、带重要确认动作的，永远不自动过期。
 * 只看所有者的收件箱（加固阶段再按用户遍历）。过期不删除，仍可在「已处理」里查到。
 */
import type { Job } from '../jobs/scheduler.js';
import type { InboxService } from './service.js';
import { actionKind, type InboxItem } from './types.js';

const DAY = 24 * 60 * 60 * 1000;
export const BRIEF_TTL_MS = 3 * DAY;
export const LOW_TTL_MS = 7 * DAY;

/** 这张卡到了现在是否该自动过期。 */
export function shouldExpire(it: InboxItem, now: Date): boolean {
  if (it.status !== 'open') return false;
  if (it.actions.some((a) => actionKind(a) !== 'normal')) return false;
  const age = now.getTime() - it.createdAt.getTime();
  if (it.group === 'brief') return age >= BRIEF_TTL_MS;
  if (it.urgency === 'low') return age >= LOW_TTL_MS;
  return false;
}

export function inboxTidyJob(inbox: InboxService, now: () => Date): Job {
  return {
    name: 'inbox-tidy',
    intervalMs: 6 * 60 * 60 * 1000,
    firstDelayMs: 120_000,
    async run(audit) {
      const open = await inbox.list({ status: 'open' });
      let n = 0;
      for (const it of open) {
        if (!shouldExpire(it, now())) continue;
        if (await inbox.expire(it.id, audit)) n++;
      }
      return n ? `expired=${n}` : '';
    },
  };
}
