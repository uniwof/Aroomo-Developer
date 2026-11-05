/**
 * 计划：校验、下次运行时间、人话（「每周一 09:00」）。cron 推算借用 Ekko（经 borrowed/ekko.ts）。
 * 最短间隔 1 小时（附录 C）；时间都按助手自己的时区。
 */
import { nextCronAt } from '../borrowed/ekko.js';
import { badRequest } from '../http/errors.js';
import type { ScheduleKind, ScheduleSpec } from './types.js';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR_MS = 3_600_000;
const WEEKDAY = ['', '一', '二', '三', '四', '五', '六', '日'];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ScheduleInput {
  kind: ScheduleKind;
  time?: string;
  days?: number[];
  everyHours?: number;
}

/** 接口入参 → 规范化的计划；不合法抛 400。 */
export function parseSchedule(s: ScheduleInput): ScheduleSpec {
  switch (s.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'daily':
      if (!s.time || !TIME_RE.test(s.time)) throw badRequest('请选择每天几点（HH:MM）', 'INVALID_SCHEDULE');
      return { kind: 'daily', time: s.time };
    case 'weekly': {
      const days = [...new Set(s.days ?? [])].sort((a, b) => a - b);
      if (!s.time || !TIME_RE.test(s.time)) throw badRequest('请选择几点（HH:MM）', 'INVALID_SCHEDULE');
      if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw badRequest('请至少选一天（1=周一 … 7=周日）', 'INVALID_SCHEDULE');
      return { kind: 'weekly', time: s.time, days };
    }
    case 'interval': {
      const h = s.everyHours;
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 168) throw badRequest('每隔几小时：1–168 的整数（最短 1 小时）', 'INVALID_SCHEDULE');
      return { kind: 'interval', everyHours: h };
    }
    default:
      throw badRequest('未知的计划类型', 'INVALID_SCHEDULE');
  }
}

function cronOf(spec: ScheduleSpec): string | null {
  if (spec.kind === 'daily' || spec.kind === 'weekly') {
    const [hh, mm] = spec.time.split(':').map(Number);
    const dow = spec.kind === 'daily' ? '*' : spec.days.map((d) => d % 7).join(',');
    return `${mm} ${hh} * * ${dow}`;
  }
  return null;
}

/**
 * 严格晚于 after 的下一次计划时间；manual = null。
 * interval：有上一次计划时间 prev 时按 prev + n 小时往后推（不漂移），没有就从 after 起算。
 */
export function nextRunAt(spec: ScheduleSpec, timezone: string, after: Date, prev?: Date | null): Date | null {
  if (spec.kind === 'manual') return null;
  if (spec.kind === 'interval') {
    const step = spec.everyHours * HOUR_MS;
    if (!prev) return new Date(after.getTime() + step);
    const k = Math.max(1, Math.floor((after.getTime() - prev.getTime()) / step) + 1);
    return new Date(prev.getTime() + k * step);
  }
  return nextCronAt(cronOf(spec)!, timezone, after);
}

/** 不晚于 now 的最近一次计划时间（错过后「补跑最近一次」用）；最多往回看 8 天，绝不一次补很多次。 */
export function latestDueAt(spec: ScheduleSpec, timezone: string, now: Date, due: Date): Date {
  if (spec.kind === 'manual') return due;
  if (spec.kind === 'interval') {
    const step = spec.everyHours * HOUR_MS;
    return new Date(due.getTime() + Math.floor((now.getTime() - due.getTime()) / step) * step);
  }
  let t = new Date(Math.max(due.getTime(), now.getTime() - 8 * 24 * HOUR_MS) - 60_000);
  let last = due;
  for (let i = 0; i < 64; i++) {
    const n = nextRunAt(spec, timezone, t);
    if (!n || n.getTime() > now.getTime()) break;
    last = n;
    t = n;
  }
  return last;
}

/** 人话：「手动」「每天 09:00」「每个工作日 09:00」「每周一、三 09:00」「每 6 小时」 */
export function scheduleText(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'manual':
      return '手动';
    case 'daily':
      return `每天 ${spec.time}`;
    case 'weekly':
      if (spec.days.join(',') === '1,2,3,4,5') return `每个工作日 ${spec.time}`;
      if (spec.days.length === 7) return `每天 ${spec.time}`;
      return `每周${spec.days.map((d) => WEEKDAY[d]).join('、')} ${spec.time}`;
    case 'interval':
      return `每 ${spec.everyHours} 小时`;
  }
}

/** 「11-09 周一 09:00」（助手的时区） */
export function shortWhen(d: Date, timezone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday ?? '') + 1;
  return `${p.month}-${p.day} 周${WEEKDAY[wd] ?? ''} ${p.hour}:${p.minute}`;
}
