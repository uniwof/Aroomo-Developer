export type ActorType = 'owner' | 'operator' | 'system' | 'member';

export interface AuditActor {
  type: ActorType;
  id: string;
}

export interface AuditTarget {
  type: string;
  id: string;
}

export type AuditResult = 'ok' | 'denied' | 'failed';

export interface AuditEntry {
  id: string;
  ts: number;
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  result: AuditResult;
  note?: string;
}

export interface NewAuditEntry {
  id?: string;
  ts?: number;
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  result: AuditResult;
  note?: string;
}

export interface AuditLogQueryParams {
  actor?: { type?: ActorType; id?: string } | string;
  action?: string;
  target?: { type?: string; id?: string } | string;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string;
}

export interface AuditQueryResult {
  items: AuditEntry[];
  nextCursor?: string;
  total: number;
}

export interface AuditLog {
  append(input: NewAuditEntry): Promise<AuditEntry>;
  query(params?: AuditLogQueryParams): Promise<AuditQueryResult>;
}
