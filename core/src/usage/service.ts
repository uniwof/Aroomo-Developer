/**
 * 额度圆环数据（D7，GET /api/usage）：Core 自己数每位成员每天（北京时间）被调用了几次、几次出错、几次被限流。
 * 上限由所有者自己填（没填 = 「未知」，圆环不画比例）；供应商返回 429 时当天标 limited。
 * 只记次数，不记内容，不含 Key。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest } from '../http/errors.js';
import type { Member } from '../members/types.js';
import { activeMembers } from '../settings/lead.js';
import type { SettingsStore } from '../settings/store.js';

export type CallOutcome = 'ok' | 'error' | 'limited';
export interface Counter {
  requests: number;
  errors: number;
  limited: number;
}
type Day = Record<string, Counter>;

const DAY = 24 * 60 * 60 * 1000;
const CST = 8 * 60 * 60 * 1000;
const LIMITS_KEY = 'usage_limits';
export const MAX_LIMIT = 10_000_000;

/** 北京时间的日期键 20261031 */
export function dayKey(d: Date): string {
  const t = new Date(Math.floor((d.getTime() + CST) / DAY) * DAY);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}
const keyOf = (day: string) => `usage.${day}`;

export type RingState = 'unknown' | 'ok' | 'warn' | 'full' | 'limited';

export function ringState(c: Counter, limit: number | null): RingState {
  if (c.limited > 0) return 'limited';
  if (limit == null) return 'unknown';
  if (c.requests >= limit) return 'full';
  return c.requests >= limit * 0.8 ? 'warn' : 'ok';
}

export class UsageService {
  #chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly settings: SettingsStore,
    private readonly now: () => Date,
  ) {}

  /** 记一次调用（排队写入，不阻塞对话、出错也不影响对话） */
  record(member: string, outcome: CallOutcome): void {
    this.#chain = this.#chain
      .then(async () => {
        const key = keyOf(dayKey(this.now()));
        const day = (await this.settings.get<Day>(key)) ?? {};
        const c = day[member] ?? { requests: 0, errors: 0, limited: 0 };
        c.requests += 1;
        if (outcome === 'error') c.errors += 1;
        if (outcome === 'limited') c.limited += 1;
        day[member] = c;
        await this.settings.set(key, day, this.now());
      })
      .catch(() => undefined);
  }

  /** 等排队的写入落盘（测试和读取前用） */
  async flush(): Promise<void> {
    await this.#chain;
  }

  async limits(): Promise<Record<string, number>> {
    return (await this.settings.get<Record<string, number>>(LIMITS_KEY)) ?? {};
  }

  /** 填/清某位成员每天的次数上限（member 用成员 id；null = 清除，回到「未知」） */
  async setLimit(member: Member, dailyLimit: number | null, audit: AuditFn): Promise<{ memberId: string; dailyLimit: number | null }> {
    if (dailyLimit !== null && (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > MAX_LIMIT)) {
      throw badRequest(`每天的次数上限填 1 到 ${MAX_LIMIT} 的整数，或清空`, 'BAD_LIMIT');
    }
    const all = await this.limits();
    if (dailyLimit === null) delete all[member.id];
    else all[member.id] = dailyLimit;
    await this.settings.set(LIMITS_KEY, all, this.now());
    await audit('usage.limit', { type: 'member', id: member.id }, 'ok', dailyLimit === null ? 'cleared' : String(dailyLimit));
    return { memberId: member.id, dailyLimit };
  }

  /** 今天 + 近 7 天合计；每位在职成员一行。tracked=false 表示这个范围不统计（账号用户的次数目前不分开记） */
  async report(members: Member[], tracked = true) {
    await this.flush();
    const now = this.now();
    const today = dayKey(now);
    const days: Day[] = [];
    for (let i = 0; i < 7 && tracked; i++) days.push((await this.settings.get<Day>(keyOf(dayKey(new Date(now.getTime() - i * DAY))))) ?? {});
    const limits = await this.limits();
    const zero = (): Counter => ({ requests: 0, errors: 0, limited: 0 });
    const rows = activeMembers(members).map((m) => {
      const t = days[0]?.[m.name] ?? zero();
      const week = days.reduce((s, d) => s + (d[m.name]?.requests ?? 0), 0);
      const limit = limits[m.id] ?? null;
      return {
        memberId: m.id,
        name: m.name,
        today: t,
        last7DaysRequests: week,
        quota: { used: t.requests, limit, unit: '次/天' },
        // 上限没填 = 未知，圆环不画比例
        quotaKnown: limit != null,
        ratio: limit != null ? Math.min(1, t.requests / limit) : null,
        state: ringState(t, limit),
      };
    });
    return {
      day: today,
      tz: 'Asia/Shanghai',
      tracked,
      total: { requests: rows.reduce((s, r) => s + r.today.requests, 0), errors: rows.reduce((s, r) => s + r.today.errors, 0), limited: rows.reduce((s, r) => s + r.today.limited, 0) },
      members: rows,
    };
  }
}
