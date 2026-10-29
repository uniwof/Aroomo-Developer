/**
 * 审计日志（PRODUCT §0.4、§3 第 7 条、§12 AuditLog；DECISIONS D50）。
 * 只追加：接口上没有任何修改或删除方法。
 */

export type ActorType = 'owner' | 'operator' | 'system' | 'member' | 'user';
export type AuditResult = 'ok' | 'denied' | 'failed';

export interface AuditActor {
  type: ActorType;
  id: string;
}

export interface AuditTarget {
  type: string;
  id: string;
}

export interface AuditEntry {
  id: string;
  ts: Date;
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  result: AuditResult;
  note?: string;
}

export interface AuditInput {
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  result: AuditResult;
  note?: string;
}

export interface AuditQuery {
  actor?: Partial<AuditActor>;
  action?: string;
  target?: Partial<AuditTarget>;
  /** ts >= from */
  from?: Date;
  /** ts < to */
  to?: Date;
  limit?: number;
  /** 上一页返回的 nextCursor */
  cursor?: string;
}

export interface AuditPage {
  /** 新的在前 */
  entries: AuditEntry[];
  nextCursor: string | null;
}

/** 只追加的审计日志。故意不提供 update / delete / clear。 */
export interface AuditLog {
  append(input: AuditInput): Promise<AuditEntry>;
  query(q?: AuditQuery): Promise<AuditPage>;
}

/** 成员 / Key / 收件箱模块约定的回调签名（Issue #5、#6、#7）。 */
export type AuditFn = (action: string, target: AuditTarget, result: AuditResult, note?: string) => Promise<void>;

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
export const AUDIT_NOTE_MAX = 2000;
