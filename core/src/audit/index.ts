import { InMemoryAuditLog } from './log.js';
import type { AuditActor, AuditEntry, AuditLog, AuditResult, AuditTarget } from './types.js';

export * from './types.js';
export * from './redact.js';
export * from './log.js';

let defaultAuditLog: AuditLog = new InMemoryAuditLog();

export function setGlobalAuditLog(log: AuditLog): void {
  defaultAuditLog = log;
}

export function getGlobalAuditLog(): AuditLog {
  return defaultAuditLog;
}

/**
 * 便捷审计日志记录函数，签名与成员/Key/收件箱 Issue 约定回调一致。
 * 默认 actor 为 system。
 */
export async function audit(
  action: string,
  target: AuditTarget,
  result: AuditResult,
  note?: string,
  actor?: AuditActor,
): Promise<AuditEntry> {
  return defaultAuditLog.append({
    actor: actor ?? { type: 'system', id: 'system' },
    action,
    target,
    result,
    note,
  });
}
