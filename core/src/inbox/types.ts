/**
 * 收件箱（PRODUCT §2.2「老板的办公桌」、§8.3、§9.9、§12 InboxItem）。
 * 三组：decision（待你拍板或接管）、candidate（候选）、brief（每日简报）。
 */
import type { ConfirmKind } from '../confirm/confirm.js';

export const INBOX_GROUPS = ['decision', 'candidate', 'brief'] as const;
export type InboxGroup = (typeof INBOX_GROUPS)[number];
export const URGENCIES = ['urgent', 'normal', 'low'] as const;
export type Urgency = (typeof URGENCIES)[number];
export type InboxStatus = 'open' | 'done' | 'dismissed' | 'expired';

export interface InboxActionConfirm {
  /** normal = 普通确认（点一下）；其他 = 重要确认（D63） */
  kind: ConfirmKind;
  /** 重要确认必填：后果，每条一句 */
  consequences?: string[];
}

export interface InboxAction {
  id: string;
  label: string;
  /** 确认级别（D63）。不写 = 普通确认 */
  confirm?: InboxActionConfirm;
  /** 旧写法（D50 时期）：等同 confirm.kind = irreversible。只为兼容已存的条目和旧调用方 */
  irreversible?: boolean;
}

/** 动作的确认种类：新写法优先，旧的 irreversible: true 视为不可逆。 */
export function actionKind(a: InboxAction): ConfirmKind {
  if (a.confirm) return a.confirm.kind;
  return a.irreversible ? 'irreversible' : 'normal';
}

export interface InboxRef {
  type: string;
  id: string;
}

export interface InboxItem {
  id: string;
  group: InboxGroup;
  kind: string;
  urgency: Urgency;
  title: string;
  summary: string;
  related?: InboxRef;
  actions: InboxAction[];
  status: InboxStatus;
  createdAt: Date;
  resolvedAt?: Date;
  resolvedAction?: string;
}

export interface InboxListFilter {
  group?: InboxGroup;
  status?: InboxStatus;
}

export interface InboxStore {
  /** 插入；若已有同 related + kind 的 open 条目则不插入，返回已有条目（原子）。 */
  insertDedup(item: InboxItem): Promise<{ item: InboxItem; created: boolean }>;
  get(id: string): Promise<InboxItem | null>;
  list(filter: InboxListFilter): Promise<InboxItem[]>;
  /** 各组 open 条目数 */
  openCounts(): Promise<Record<InboxGroup, number>>;
  /**
   * 比较并交换：只有当前 status 为 open 时才改成 next.status，返回更新后的条目；
   * 已不是 open 返回 null。并发重复请求只有一个能成功。
   */
  resolveIfOpen(id: string, next: { status: Exclude<InboxStatus, 'open'>; resolvedAt: Date; resolvedAction?: string }): Promise<InboxItem | null>;
}

export const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, normal: 1, low: 2 };

/** open 在前，再按紧急度，再按时间（新的在前）。 */
export function compareInbox(a: InboxItem, b: InboxItem): number {
  const ao = a.status === 'open' ? 0 : 1;
  const bo = b.status === 'open' ? 0 : 1;
  if (ao !== bo) return ao - bo;
  const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (u !== 0) return u;
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  return t !== 0 ? t : a.id.localeCompare(b.id);
}
