/**
 * 试用到期（M4）：所有者给某个「试用」能力填到期日（YYYY-MM-DD，北京时间当天结束前有效），
 * 能力清单据此显示剩余天数；每天一次，临近（≤3 天）或已过期的发一张收件箱提醒。
 * 种子数据里没有到期日（旧站清单没写），所以由所有者填，或以后由执行员读到后写入。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest, notFound } from '../http/errors.js';
import type { InboxService } from '../inbox/service.js';
import type { Job } from '../jobs/scheduler.js';
import type { SettingsStore } from '../settings/store.js';
import { CAPABILITY_SEED } from './seed.js';

const KEY = 'capability_trials';
const DAY = 24 * 60 * 60 * 1000;
const CST = 8 * 60 * 60 * 1000;
export const REMIND_DAYS = 3;

type Trials = Record<string, string>;

/** 到期日剩余整天数（北京时间按日历日算）：今天到期=0，昨天到期=-1 */
export function daysLeft(endsAt: string, now: Date): number {
  const end = Date.parse(`${endsAt}T00:00:00Z`);
  const today = Math.floor((now.getTime() + CST) / DAY) * DAY;
  return Math.round((end - today) / DAY);
}

export class TrialService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly now: () => Date,
  ) {}

  async all(): Promise<Trials> {
    return (await this.settings.get<Trials>(KEY)) ?? {};
  }

  /** 给能力清单每一项补 trialEndsAt / trialDaysLeft（没填为 null） */
  async decorate<T extends { id: string }>(items: T[]): Promise<(T & { trialEndsAt: string | null; trialDaysLeft: number | null })[]> {
    const t = await this.all();
    const at = this.now();
    return items.map((i) => ({ ...i, trialEndsAt: t[i.id] ?? null, trialDaysLeft: t[i.id] ? daysLeft(t[i.id]!, at) : null }));
  }

  async set(id: string, endsAt: string | null, audit: AuditFn): Promise<{ id: string; trialEndsAt: string | null; trialDaysLeft: number | null }> {
    const known = [...CAPABILITY_SEED.items, ...CAPABILITY_SEED.tools].find((c) => c.id === id);
    if (!known) throw notFound('找不到这个能力');
    if (known.access !== 'trial') throw badRequest('只有「试用」的能力需要填到期日', 'NOT_TRIAL');
    if (endsAt !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(endsAt) || Number.isNaN(Date.parse(`${endsAt}T00:00:00Z`)) || new Date(`${endsAt}T00:00:00Z`).toISOString().slice(0, 10) !== endsAt))
      throw badRequest('到期日写成 年-月-日，例如 2026-12-31', 'BAD_DATE');
    const t = await this.all();
    if (endsAt === null) delete t[id];
    else t[id] = endsAt;
    await this.settings.set(KEY, t, this.now());
    await audit('capability.trial', { type: 'capability', id }, 'ok', endsAt ?? 'cleared');
    return { id, trialEndsAt: endsAt, trialDaysLeft: endsAt ? daysLeft(endsAt, this.now()) : null };
  }

  /** 临近或已过期的试用（按剩余天数从少到多） */
  async due(): Promise<{ id: string; name: string; endsAt: string; left: number }[]> {
    const t = await this.all();
    const at = this.now();
    const names = new Map([...CAPABILITY_SEED.items, ...CAPABILITY_SEED.tools].map((c) => [c.id, c.name]));
    return Object.entries(t)
      .map(([id, endsAt]) => ({ id, name: names.get(id) ?? id, endsAt, left: daysLeft(endsAt, at) }))
      .filter((x) => x.left <= REMIND_DAYS)
      .sort((a, b) => a.left - b.left);
  }
}

/** 每 6 小时看一次；收件箱按 related(type+id)+kind 去重，所以同一个能力的同一档提醒不会重复发。 */
export function trialExpiryJob(trials: TrialService, inbox: InboxService): Job {
  return {
    name: 'trial-expiry',
    intervalMs: 6 * 60 * 60 * 1000,
    firstDelayMs: 120_000,
    async run(audit) {
      let n = 0;
      for (const d of await trials.due()) {
        const expired = d.left < 0;
        const r = await inbox.createInboxItem(
          {
            group: 'decision',
            kind: expired ? 'trial-expired' : 'trial-expiring',
            urgency: expired || d.left <= 1 ? 'urgent' : 'normal',
            title: expired ? `试用「${d.name}」已经到期` : d.left === 0 ? `试用「${d.name}」今天到期` : `试用「${d.name}」还剩 ${d.left} 天`,
            summary: `到期日 ${d.endsAt}。到期后这个能力可能不能用或开始收费；要继续用请自己决定是否续费，不想用可以忽略。`,
            related: { type: 'capability', id: d.id },
            actions: [{ id: 'ack', label: '知道了' }],
          },
          audit,
        );
        if (r.created) n++;
      }
      return n ? `reminded=${n}` : '';
    },
  };
}
