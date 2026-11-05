// Derived from Ekko Studio (BSL 1.1), source packages/server/src/modules/studio/services/workflow/schedule.ts@59530f6 — non-commercial; strip before paid launch (third_party/ekko/BORROWED.md)
// 只取第 17–81 行的纯函数（cron 解析与下一次时间）；后半段依赖 Ekko 的 manager / users-store，未抄。
const MINUTE = 60_000

const CRON_PRESETS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

export function normalizeWorkflowSchedule(schedule: string): string {
  const normalized = schedule.trim()
  return CRON_PRESETS[normalized.toLowerCase()] || normalized
}

function values(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range = '', stepRaw] = part.split('/') // Aroomo：noUncheckedIndexedAccess 默认值
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error('invalid cron step')
    const [fromRaw, toRaw] = range === '*' ? [String(min), String(max)] : range.split('-')
    const from = Number(fromRaw)
    const to = toRaw === undefined ? from : Number(toRaw)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) throw new Error('invalid cron field')
    for (let value = from; value <= to; value += step) out.add(value)
  }
  return out
}

export function assertWorkflowScheduleCron(schedule: string): void {
  const fields = normalizeWorkflowSchedule(schedule).split(/\s+/)
  if (fields.length !== 5) throw new Error('schedule must be a five-field cron expression')
  values(fields[0] ?? '', 0, 59)
  values(fields[1] ?? '', 0, 23)
  values(fields[2] ?? '', 1, 31)
  values(fields[3] ?? '', 1, 12)
  values(fields[4] ?? '', 0, 6)
}

function zoned(date: number, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(date))
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find(part => part.type === 'weekday')?.value || '')
  return [value('minute'), value('hour'), value('day'), value('month'), weekday]
}

export function nextWorkflowScheduleAt(schedule: string, timezone: string, after: number): number {
  assertWorkflowScheduleCron(schedule)
  new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  const fields = normalizeWorkflowSchedule(schedule).split(/\s+/).map((field, index) => values(field, [0, 0, 1, 1, 0][index]!, [59, 23, 31, 12, 6][index]!))
  let candidate = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const limit = candidate + 366 * 24 * 60 * MINUTE
  while (candidate <= limit) {
    const parts = zoned(candidate, timezone)
    if (parts.every((value, index) => fields[index]!.has(value))) return candidate
    candidate += MINUTE
  }
  throw new Error('schedule has no occurrence in the next year')
}
