/**
 * 助手计划的人话（X-02 定时列表、X-15 草稿卡、7.11 新建弹窗共用）。字段和线 C 设计稿 / 指南附录 C 对齐：
 * schedule_kind manual / daily / weekly / interval，schedule_spec { time: 'HH:MM', days: 1–7（周一=1）, everyHours }（字段名照 Core 的 ScheduleSpec）。
 * 不让她写 cron：新建时只给预设（每天 09:00、每个工作日 09:00、每周一 09:00、每 6 小时）。
 */
export type ScheduleKind = 'manual' | 'daily' | 'weekly' | 'interval';
export interface ScheduleSpec {
  time?: string;
  days?: number[];
  everyHours?: number;
}

const DAY = ['', '一', '二', '三', '四', '五', '六', '日'];

export const PRESETS: { id: string; label: string; kind: ScheduleKind; spec: ScheduleSpec }[] = [
  { id: 'daily-9', label: '每天 09:00', kind: 'daily', spec: { time: '09:00' } },
  { id: 'workday-9', label: '每个工作日 09:00', kind: 'weekly', spec: { time: '09:00', days: [1, 2, 3, 4, 5] } },
  { id: 'monday-9', label: '每周一 09:00', kind: 'weekly', spec: { time: '09:00', days: [1] } },
  { id: 'every-6h', label: '每 6 小时', kind: 'interval', spec: { everyHours: 6 } },
];

/** 「只在我叫它时」「每天 09:00」「每个工作日 09:00」「每周一、三 09:00」「每 6 小时」；数据不对时写「计划没设好」，不编造 */
export function scheduleText(kind: ScheduleKind, spec: ScheduleSpec = {}): string {
  const t = spec.time && /^\d{2}:\d{2}$/.test(spec.time) ? spec.time : '';
  if (kind === 'manual') return '只在我叫它时';
  if (kind === 'interval') return spec.everyHours && spec.everyHours >= 1 ? `每 ${spec.everyHours} 小时` : '计划没设好';
  if (!t) return '计划没设好';
  if (kind === 'daily') return `每天 ${t}`;
  const days = [...new Set(spec.days ?? [])].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (days.length === 0) return '计划没设好';
  if (days.length === 7) return `每天 ${t}`;
  if (days.join() === '1,2,3,4,5') return `每个工作日 ${t}`;
  if (days.join() === '6,7') return `每个周末 ${t}`;
  return `每周${days.map((d) => DAY[d]).join('、')} ${t}`;
}

/** 时区的人话：和这台设备一样就写「本机时区」，否则写时区名 */
export function zoneText(zone: string, local = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return zone === local ? '本机时区' : zone;
}

/** 下次运行「11-09 周一 09:00」，按助手的时区显示；没有就写「—」 */
export function whenText(iso: string | null | undefined, zone?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', { ...(zone ? { timeZone: zone } : {}), month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}-${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`;
}

/** 任务说明第一句当「目标」，其余当「指令摘要」 */
export function splitInstructions(text: string): { goal: string; rest: string } {
  const t = text.trim();
  const m = /^[^。！？!?\n]*[。！？!?]?/.exec(t);
  const goal = (m?.[0] ?? t).trim() || t;
  return { goal, rest: t.slice(goal.length).trim() };
}
