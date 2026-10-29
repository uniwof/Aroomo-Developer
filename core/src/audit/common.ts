import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  AUDIT_NOTE_MAX,
  type AuditEntry,
  type AuditInput,
  type AuditLog,
  type AuditFn,
  type AuditActor,
} from './types.js';

const ACTOR_TYPES = new Set(['owner', 'operator', 'system', 'member', 'user']);
const RESULTS = new Set(['ok', 'denied', 'failed']);

/** 校验 + 脱敏，得到可以落库的条目（不含 id/ts）。 */
export function sanitize(input: AuditInput): AuditInput {
  if (!ACTOR_TYPES.has(input.actor.type)) throw new Error(`非法 actor.type`);
  if (!RESULTS.has(input.result)) throw new Error(`非法 result`);
  if (!input.action) throw new Error('action 不能为空');
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const out: AuditInput = {
    actor: { type: input.actor.type, id: clip(redactSecrets(String(input.actor.id)), 200) },
    action: clip(redactSecrets(input.action), 200),
    target: { type: clip(redactSecrets(String(input.target.type)), 100), id: clip(redactSecrets(String(input.target.id)), 200) },
    result: input.result,
  };
  if (input.note !== undefined && input.note !== '') out.note = clip(redactSecrets(input.note), AUDIT_NOTE_MAX);
  return out;
}

export function newEntryId(): string {
  return randomUUID();
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return AUDIT_DEFAULT_LIMIT;
  return Math.max(1, Math.min(AUDIT_MAX_LIMIT, Math.floor(limit)));
}

export function encodeCursor(seq: number | string): string {
  return Buffer.from(`a:${seq}`, 'utf8').toString('base64url');
}

/** 非法游标返回 null，由调用方报 400。 */
export function decodeCursor(cursor: string): number | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^a:(\d{1,18})$/.exec(raw);
  return m ? Number(m[1]) : null;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor 不合法');
    this.name = 'InvalidCursorError';
  }
}

export function freezeEntry(e: AuditEntry): AuditEntry {
  Object.freeze(e.actor);
  Object.freeze(e.target);
  return Object.freeze(e);
}

/** 便捷函数：把 actor 绑定好，得到各模块约定的 audit(action, target, result, note?) 回调。 */
export function bindAudit(log: AuditLog, actor: AuditActor): AuditFn {
  return async (action, target, result, note) => {
    await log.append({ actor, action, target, result, ...(note !== undefined ? { note } : {}) });
  };
}
