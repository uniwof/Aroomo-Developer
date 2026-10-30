import type { Db } from "../db/db.js";
import { toDate, toDateOrNull } from "../db/db.js";
import type {
  ExecutorRecord,
  ExecutorStore,
  TaskKind,
  TaskRecord,
  TakeoverRecord,
  TaskStatus,
} from "./types.js";

const toEx = (r: Record<string, unknown>): ExecutorRecord => ({
  id: r.id as string,
  userId: r.user_id as string,
  clientId: r.client_id as string,
  deviceName: r.device_name as string,
  platform: r.platform as string,
  version: r.version as string,
  adapters: r.adapters as string[],
  createdAt: toDate(r.created_at),
  lastSeenAt: toDate(r.last_seen_at),
});
const toTask = (r: Record<string, unknown>): TaskRecord => ({
  id: r.id as string,
  userId: r.user_id as string,
  kind: r.kind as TaskKind,
  site: r.site as string,
  instruction: r.instruction as string,
  secrets: r.secrets as TaskRecord["secrets"],
  options: r.options as Record<string, unknown>,
  status: r.status as TaskStatus,
  executorId: (r.executor_id as string | null) ?? null,
  leaseExpiresAt: toDateOrNull(r.lease_expires_at),
  cancelRequested: r.cancel_requested as boolean,
  lastStage: (r.last_stage as string | null) ?? null,
  lastMessage: (r.last_message as string | null) ?? null,
  resultSummary: (r.result_summary as string | null) ?? null,
  resultError: (r.result_error as string | null) ?? null,
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});

const toTk = (r: Record<string, unknown>): TakeoverRecord => ({
  id: r.id as string,
  userId: r.user_id as string,
  taskId: r.task_id as string,
  reason: r.reason as string,
  message: r.message as string,
  status: r.status as TakeoverRecord["status"],
  note: (r.note as string | null) ?? null,
  createdAt: toDate(r.created_at),
  resolvedAt: toDateOrNull(r.resolved_at),
});

export class PgExecutorStore implements ExecutorStore {
  constructor(private readonly db: Db) {}

  async insertTakeover(t: TakeoverRecord) {
    await this.db.query(
      `INSERT INTO exec_takeovers (id, user_id, task_id, reason, message, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [t.id, t.userId, t.taskId, t.reason, t.message, t.createdAt],
    );
  }
  async getTakeover(userId: string, taskId: string, id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM exec_takeovers WHERE user_id = $1 AND task_id = $2 AND id = $3",
      [userId, taskId, id],
    );
    return rows[0] ? toTk(rows[0]) : null;
  }
  async listTakeovers(userId: string, taskId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM exec_takeovers WHERE user_id = $1 AND task_id = $2 ORDER BY created_at",
      [userId, taskId],
    );
    return rows.map(toTk);
  }
  async resolveTakeover(
    userId: string,
    taskId: string,
    id: string,
    status: "resolved" | "cancelled",
    note: string | null,
    now: Date,
  ) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE exec_takeovers SET status = $4, note = $5, resolved_at = $6
       WHERE user_id = $1 AND task_id = $2 AND id = $3 AND status = 'pending' RETURNING *`,
      [userId, taskId, id, status, note, now],
    );
    return rows[0] ? toTk(rows[0]) : null;
  }

  async upsertExecutor(r: ExecutorRecord): Promise<ExecutorRecord> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO executors (id, user_id, client_id, device_name, platform, version, adapters, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, client_id) DO UPDATE SET device_name = EXCLUDED.device_name, platform = EXCLUDED.platform,
         version = EXCLUDED.version, adapters = EXCLUDED.adapters, last_seen_at = EXCLUDED.last_seen_at
       RETURNING *`,
      [
        r.id,
        r.userId,
        r.clientId,
        r.deviceName,
        r.platform,
        r.version,
        r.adapters,
        r.createdAt,
        r.lastSeenAt,
      ],
    );
    return toEx(rows[0] as Record<string, unknown>);
  }
  async getExecutor(userId: string, id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM executors WHERE user_id = $1 AND id = $2",
      [userId, id],
    );
    return rows[0] ? toEx(rows[0]) : null;
  }
  async touchExecutor(userId: string, id: string, at: Date) {
    await this.db.query(
      "UPDATE executors SET last_seen_at = $3 WHERE user_id = $1 AND id = $2",
      [userId, id, at],
    );
  }
  async listExecutors(userId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM executors WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    return rows.map(toEx);
  }
  async insertTask(t: TaskRecord) {
    await this.db.query(
      `INSERT INTO exec_tasks (id, user_id, kind, site, instruction, secrets, options, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [
        t.id,
        t.userId,
        t.kind,
        t.site,
        t.instruction,
        JSON.stringify(t.secrets),
        JSON.stringify(t.options),
        t.status,
        t.createdAt,
        t.updatedAt,
      ],
    );
  }
  async getTask(userId: string, id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM exec_tasks WHERE user_id = $1 AND id = $2",
      [userId, id],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }
  async listTasks(userId: string, limit: number) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM exec_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    return rows.map(toTask);
  }
  async claim(
    userId: string,
    executorId: string,
    kinds: string[] | null,
    now: Date,
    leaseUntil: Date,
  ) {
    await this.db.query(
      `UPDATE exec_tasks SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END, executor_id = NULL, lease_expires_at = NULL, updated_at = $2
       WHERE user_id = $1 AND status = 'running' AND lease_expires_at <= $2`,
      [userId, now],
    );
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE exec_tasks SET status = 'running', executor_id = $2, lease_expires_at = $4, updated_at = $3
       WHERE id = (SELECT id FROM exec_tasks WHERE user_id = $1 AND status = 'queued' AND ($5::text[] IS NULL OR kind = ANY($5::text[]))
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [userId, executorId, now, leaseUntil, kinds],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }
  async sweep(now: Date, queuedBefore: Date) {
    const a = await this.db.query<{ id: string }>(
      `UPDATE exec_tasks SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END, executor_id = NULL, lease_expires_at = NULL, updated_at = $1
       WHERE status = 'running' AND lease_expires_at <= $1 RETURNING id`,
      [now],
    );
    const b = await this.db.query<{ id: string }>(
      `UPDATE exec_tasks SET status = 'failed', result_error = 'NO_EXECUTOR', result_summary = '超过时限没有执行员领取，已过期', updated_at = $1
       WHERE status = 'queued' AND created_at < $2 RETURNING id`,
      [now, queuedBefore],
    );
    return { requeued: a.rows.length, expired: b.rows.length };
  }
  async renew(
    userId: string,
    id: string,
    executorId: string,
    now: Date,
    leaseUntil: Date,
    stage: string,
    message: string,
  ) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE exec_tasks SET lease_expires_at = $5, last_stage = $6, last_message = $7, updated_at = $4
       WHERE user_id = $1 AND id = $2 AND executor_id = $3 AND status = 'running' AND lease_expires_at > $4 RETURNING *`,
      [userId, id, executorId, now, leaseUntil, stage, message],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }
  async finish(
    userId: string,
    id: string,
    executorId: string,
    status: "succeeded" | "failed" | "cancelled",
    summary: string,
    error: string | null,
    now: Date,
  ) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE exec_tasks SET status = $5, result_summary = $6, result_error = $7, lease_expires_at = NULL, updated_at = $4
       WHERE user_id = $1 AND id = $2 AND executor_id = $3 AND status = 'running' AND lease_expires_at > $4 RETURNING *`,
      [userId, id, executorId, now, status, summary, error],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }
  async cancel(userId: string, id: string, now: Date) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE exec_tasks SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         cancel_requested = CASE WHEN status = 'running' THEN true ELSE cancel_requested END, updated_at = $3
       WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, now],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }
}
