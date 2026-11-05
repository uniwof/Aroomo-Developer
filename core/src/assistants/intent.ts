/**
 * X-15 聊天里认出「要建一个定时助手」（design-assistants-v1 §7.6）：只用规则，不调模型（零费用）。
 * 宁可漏认也不错认：必须同时有「计划」（每天 / 每周几 / 每个工作日 + 几点，或每 N 小时）和「请求」（帮我 / 替我 / 提醒我…）；
 * 有疑问词、否定词、@点名、太长的一律不认。认出来也只是发一张草稿卡，点「建好」才建。
 * shortcut: 只认这几种说法（不认「每月」「隔天」「明天」这类），以后要更宽再换成免费模型判断。
 */
import type { ScheduleInput } from './schedule.js';

export interface AssistantIntent {
  name: string;
  instructions: string;
  schedule: ScheduleInput;
}

const MAX_LEN = 300;
const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const DAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/** 「9」「09」「九」「十二」「二十」→ 数字；认不出返回 null */
export function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return null;
  if (s.length === 1) return CN[s] ?? null;
  const i = s.indexOf('十');
  if (i < 0) return null;
  const tens = i === 0 ? 1 : (CN[s[0]!] ?? NaN);
  const ones = i === s.length - 1 ? 0 : (CN[s[i + 1]!] ?? NaN);
  const n = tens * 10 + ones;
  return Number.isFinite(n) ? n : null;
}

const NUM = '(\\d{1,3}|[零一二两三四五六七八九十]{1,3})';
const INTERVAL_RE = new RegExp(`每(?:隔)?\\s*${NUM}\\s*个?\\s*(?:小时|钟头)`);
const WORKDAY_RE = /每个?工作日|工作日每天|每周一(?:到|至)(?:周)?五|周一(?:到|至)周五每天/;
const WEEKEND_RE = /每个?周末/;
const WEEKLY_RE = /(?:每周|每星期|每个?礼拜)([一二三四五六日天](?:\s*[、,，和及]?\s*(?:周|星期)?[一二三四五六日天])*)/;
const DAILY_RE = /每天|每日|天天|每早|每晚/;
const TIME_RE = new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\\s*(?:(\\d{1,2})\\s*[:：]\\s*(\\d{2})|${NUM}\\s*点\\s*(半|一刻|(\\d{1,2})\\s*分?)?)`);
const REQUEST_RE = /帮我|帮忙|替我|给我|提醒我|请你|麻烦你/;
/** 疑问、否定、管理已有助手：都不是「建一个新的」 */
const REJECT_RE = /[?？]|怎么|如何|为什么|为啥|是不是|什么|哪|吗|不要|不需要|不想|不用|别|取消|停掉|停止|暂停|不再|删|改成|改到|以前|昨天|上周/;

function parseTime(m: RegExpExecArray, evening: boolean): string | null {
  const part = m[1] ?? (evening ? '晚上' : undefined);
  let h: number | null;
  let min = 0;
  if (m[2] !== undefined) {
    h = Number(m[2]);
    min = Number(m[3]);
  } else {
    h = cnNumber(m[4] ?? '');
    if (m[5] === '半') min = 30;
    else if (m[5] === '一刻') min = 15;
    else if (m[6] !== undefined) min = Number(m[6]);
  }
  if (h === null || h > 24 || min > 59) return null;
  // 「晚上 12 点」是第二天 00:00：配上「每周一」会差一天，宁可不认
  if ((part === '晚上' || part === '夜里') && h === 12) return null;
  if ((part === '下午' || part === '傍晚' || part === '晚上' || part === '夜里') && h < 12) h += 12;
  else if (part === '中午' && h < 11) h += 12;
  if (h === 24) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 认出来返回草稿要的名字、任务说明、计划；认不出返回 null */
export function detectAssistantIntent(text: string): AssistantIntent | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 8 || t.length > MAX_LEN || t.includes('@') || REJECT_RE.test(t)) return null;
  const req = REQUEST_RE.exec(t);
  if (!req) return null;
  // 计划要写在请求前面（「每周一 9 点帮我…」）；「帮我看看每天 9 点的会」这类不认
  const head = t.slice(0, req.index);
  let schedule: ScheduleInput | null = null;
  const iv = INTERVAL_RE.exec(head);
  if (iv) {
    const h = cnNumber(iv[1]!);
    if (h === null || h < 1 || h > 168) return null;
    schedule = { kind: 'interval', everyHours: h };
  } else {
    const tm = TIME_RE.exec(head);
    const time = tm ? parseTime(tm, /每晚/.test(head)) : null;
    if (!time) return null;
    const wk = WEEKLY_RE.exec(head);
    if (WORKDAY_RE.test(head)) schedule = { kind: 'weekly', time, days: [1, 2, 3, 4, 5] };
    else if (WEEKEND_RE.test(head)) schedule = { kind: 'weekly', time, days: [6, 7] };
    else if (wk) {
      const days = [...new Set([...wk[1]!].map((c) => DAY[c]).filter((d): d is number => d !== undefined))].sort((a, b) => a - b);
      if (days.length === 0) return null;
      schedule = days.length === 7 ? { kind: 'daily', time } : { kind: 'weekly', time, days };
    } else if (DAILY_RE.test(head)) schedule = { kind: 'daily', time };
    else return null;
  }
  // 任务 = 请求词后面的话（「提醒我」留着，它本身就是任务的一部分）
  const after = t.slice(req.index + (req[0] === '提醒我' ? 0 : req[0].length)).replace(/^[\s，,。:：、的]+/, '').trim();
  if (Array.from(after.replace(/[\s\p{P}]/gu, '')).length < 4) return null;
  const name = Array.from(after.split(/[，,。.；;！!]/)[0]!.replace(/一下$/, '').trim()).slice(0, 12).join('');
  if (!name) return null;
  return { name, instructions: Array.from(after).length >= 10 ? after : t, schedule };
}
