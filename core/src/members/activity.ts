/**
 * 成员此刻的状态（Poke 规范 §5 StaminaHalo；docs/api/design-poke-data-v1.md「状态推导」）。
 * 只从真实信号推出，按顺序取第一个成立的；不给百分比、不猜恢复时间。只读，不存库。
 */
import type { Member } from './types.js';

export type ActivityState = 'working' | 'cooldown' | 'depleted' | 'ready' | 'unknown';

export interface MemberActivity {
  state: ActivityState;
  /** 给人看的一句依据；ready 没有 */
  reason?: string;
  /** 这个状态从什么时候起（ISO），知道才给 */
  since?: string;
}

/** 供应商限流后多久内算「冷却」 */
export const COOLDOWN_MS = 10 * 60 * 1000;

export interface ActivitySignals {
  /** 这位是否有状态正常的 Key 对着它（= 列表里的 online） */
  online: boolean;
  /** 正在跑的那一步开始的时间；没在干活 = null */
  workingSince: Date | null;
  /** 今天的计数；null = 这个范围不统计用量（账号用户） */
  today: { requests: number; lastLimitedAt?: string } | null;
  /** 所有者填的每天上限；没填 = null */
  limit: number | null;
  now: Date;
}

export function memberActivity(m: Member, s: ActivitySignals): MemberActivity {
  if (!m.enabled) return { state: 'unknown', reason: '已停用' };
  if (m.status === 'candidate') return { state: 'unknown', reason: '候选，还没入职' };
  if (s.workingSince) return { state: 'working', reason: '正在跑助手的一步', since: s.workingSince.toISOString() };
  const last = s.today?.lastLimitedAt ? new Date(s.today.lastLimitedAt) : null;
  if (last && !Number.isNaN(last.getTime()) && s.now.getTime() - last.getTime() < COOLDOWN_MS) {
    return { state: 'cooldown', reason: '供应商刚限流过（429），稍后再试', since: last.toISOString() };
  }
  if (s.today && s.limit != null && s.today.requests >= s.limit) return { state: 'depleted', reason: '今天的次数已到你填的上限' };
  if (s.online) return { state: 'ready' };
  return { state: 'unknown', reason: '没有可用的 Key' };
}
