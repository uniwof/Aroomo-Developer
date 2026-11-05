/**
 * PostgreSQL 实现。每个方法都在 userScoped 事务里（app.user_id = 账号，D206 RLS），SQL 里也照样带 user_id（双保险）。
 * system* 两个方法用 systemScoped 只读（进 core/test/system-scoped-allowlist.test.ts 白名单）：
 * 重启恢复、定时执行器第一步需要跨账号找行；改写一律切回 userScoped。
 */
import type { Db, Queryable } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { systemScoped, userScoped } from '../db/scope.js';
import type {
  Assistant,
  AssistantMemberLink,
  AssistantRun,
  AssistantStore,
  AssistantSummary,
  BudgetLevel,
  CatchUp,
  ClaimTx,
  Conversation,
  ConversationMessage,
  InsertRunResult,
  RunFailureCode,
  RunStatus,
  RunStepEvent,
  ScheduleSpec,
  StepAction,
  StepStatus,
  UsageState,
} from './types.js';

type Ts = Date | string;
interface ARow {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  lead_member_id: string | null;
  enabled: boolean;
  schedule_kind: ScheduleSpec['kind'];
  schedule_spec: Record<string, unknown> | string;
  timezone: string;
  catch_up: CatchUp;
  max_runtime_sec: number;
  budget_level: BudgetLevel;
  notify: boolean;
  conversation_id: string;
  next_run_at: Ts | null;
  paused_at: Ts | null;
  idempotency_key: string | null;
  idempotency_hash: string | null;
  created_at: Ts;
  updated_at: Ts;
  members: AssistantMemberLink[] | string | null;
}
const A_COLS = `a.id, a.user_id, a.name, a.instructions, a.lead_member_id, a.enabled, a.schedule_kind, a.schedule_spec, a.timezone, a.catch_up,
  a.max_runtime_sec, a.budget_level, a.notify, a.conversation_id, a.next_run_at, a.paused_at, a.idempotency_key, a.idempotency_hash, a.created_at, a.updated_at,
  (SELECT coalesce(json_agg(json_build_object('memberId', m.member_id, 'role', m.role, 'position', m.position) ORDER BY m.position, m.member_id), '[]'::json)
     FROM assistant_members m WHERE m.assistant_id = a.id AND m.user_id = a.user_id) AS members`;

const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

function toAssistant(r: ARow): Assistant {
  const spec = json<Record<string, unknown>>(r.schedule_spec);
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    instructions: r.instructions,
    leadMemberId: r.lead_member_id,
    members: json<AssistantMemberLink[]>(r.members ?? '[]').map((m) => ({ memberId: m.memberId, role: m.role, position: Number(m.position) })),
    enabled: r.enabled,
    schedule: { ...spec, kind: r.schedule_kind } as ScheduleSpec,
    timezone: r.timezone,
    catchUp: r.catch_up,
    maxRuntimeSec: Number(r.max_runtime_sec),
    budgetLevel: r.budget_level,
    notify: r.notify,
    conversationId: r.conversation_id,
    nextRunAt: toDateOrNull(r.next_run_at),
    pausedAt: toDateOrNull(r.paused_at),
    idempotencyKey: r.idempotency_key,
    idempotencyHash: r.idempotency_hash,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

interface RRow {
  id: string;
  assistant_id: string;
  user_id: string;
  trigger: 'manual' | 'schedule';
  scheduled_for: Ts | null;
  idempotency_key: string | null;
  requested_at: Ts;
  started_at: Ts | null;
  finished_at: Ts | null;
  status: RunStatus;
  failure_code: RunFailureCode | null;
  summary: string | null;
  usage_state: UsageState | null;
  calls: number;
  message_ids: string[] | null;
}
const R_COLS = 'id, assistant_id, user_id, trigger, scheduled_for, idempotency_key, requested_at, started_at, finished_at, status, failure_code, summary, usage_state, calls, message_ids';
const toRun = (r: RRow): AssistantRun => ({
  id: r.id,
  assistantId: r.assistant_id,
  userId: r.user_id,
  trigger: r.trigger,
  scheduledFor: toDateOrNull(r.scheduled_for),
  idempotencyKey: r.idempotency_key,
  requestedAt: toDate(r.requested_at),
  startedAt: toDateOrNull(r.started_at),
  finishedAt: toDateOrNull(r.finished_at),
  status: r.status,
  failureCode: r.failure_code,
  summary: r.summary,
  usageState: r.usage_state,
  calls: Number(r.calls),
  messageIds: r.message_ids ?? [],
});

const specJson = (s: ScheduleSpec): string => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'kind')));

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

async function insertRunQ(q: Queryable, r: AssistantRun): Promise<InsertRunResult> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO assistant_runs (${R_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid[])
     ON CONFLICT DO NOTHING RETURNING id`,
    [r.id, r.assistantId, r.userId, r.trigger, r.scheduledFor, r.idempotencyKey, r.requestedAt, r.startedAt, r.finishedAt, r.status, r.failureCode, r.summary, r.usageState, r.calls, r.messageIds],
  );
  return rows[0] ? 'ok' : 'conflict';
}

async function insertMessageQ(q: Queryable, userId: string, m: ConversationMessage): Promise<void> {
  await q.query(
    'INSERT INTO conversation_messages (id, conversation_id, user_id, role, member_id, run_id, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [m.id, m.conversationId, userId, m.role, m.memberId, m.runId, m.content, m.createdAt],
  );
}

async function writeMembers(q: Queryable, a: Assistant): Promise<void> {
  await q.query('DELETE FROM assistant_members WHERE assistant_id = $1 AND user_id = $2', [a.id, a.userId]);
  for (const m of a.members) {
    await q.query('INSERT INTO assistant_members (assistant_id, user_id, member_id, role, position) VALUES ($1,$2,$3,$4,$5)', [a.id, a.userId, m.memberId, m.role, m.position]);
  }
}

export class PgAssistantStore implements AssistantStore {
  constructor(private readonly db: Db) {}

  #u(userId: string): Db {
    return userScoped(this.db, userId);
  }

  async countAssistants(userId: string): Promise<number> {
    const { rows } = await this.#u(userId).query<{ n: number }>('SELECT count(*)::int AS n FROM assistants WHERE user_id = $1', [userId]);
    return Number(rows[0]?.n ?? 0);
  }

  async listAssistants(userId: string): Promise<AssistantSummary[]> {
    return this.#u(userId).tx(async (q) => {
      const { rows } = await q.query<ARow & { unread: boolean }>(
        `SELECT ${A_COLS},
           EXISTS (SELECT 1 FROM conversation_messages cm JOIN conversations c ON c.id = cm.conversation_id
                    WHERE cm.conversation_id = a.conversation_id AND cm.user_id = a.user_id AND (c.read_at IS NULL OR cm.created_at > c.read_at)) AS unread
           FROM assistants a WHERE a.user_id = $1 ORDER BY a.created_at, a.id`,
        [userId],
      );
      const runs = await q.query<RRow & { kind: 'last' | 'active' }>(
        `SELECT * FROM (
           SELECT DISTINCT ON (assistant_id) 'last' AS kind, ${R_COLS} FROM assistant_runs WHERE user_id = $1 ORDER BY assistant_id, requested_at DESC, id DESC) l
         UNION ALL
         SELECT 'active' AS kind, ${R_COLS} FROM assistant_runs WHERE user_id = $1 AND status IN ('queued','running')`,
        [userId],
      );
      return rows.map((r) => ({
        assistant: toAssistant(r),
        lastRun: runs.rows.filter((x) => x.kind === 'last' && x.assistant_id === r.id).map(toRun)[0] ?? null,
        activeRun: runs.rows.filter((x) => x.kind === 'active' && x.assistant_id === r.id).map(toRun)[0] ?? null,
        unread: r.unread,
      }));
    });
  }

  async getAssistant(userId: string, id: string): Promise<Assistant | null> {
    const { rows } = await this.#u(userId).query<ARow>(`SELECT ${A_COLS} FROM assistants a WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
    return rows[0] ? toAssistant(rows[0]) : null;
  }

  async findAssistantByKey(userId: string, key: string): Promise<Assistant | null> {
    const { rows } = await this.#u(userId).query<ARow>(`SELECT ${A_COLS} FROM assistants a WHERE a.idempotency_key = $1 AND a.user_id = $2`, [key, userId]);
    return rows[0] ? toAssistant(rows[0]) : null;
  }

  async createAssistant(userId: string, a: Assistant, c: Conversation, opening: ConversationMessage): Promise<InsertRunResult> {
    try {
      await this.#u(userId).tx(async (q) => {
        await q.query(
          'INSERT INTO conversations (id, user_id, kind, title, member_ids, read_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8)',
          [c.id, userId, c.kind, c.title, c.memberIds, c.readAt, c.createdAt, c.updatedAt],
        );
        await q.query(
          `INSERT INTO assistants (id, user_id, name, instructions, lead_member_id, enabled, schedule_kind, schedule_spec, timezone, catch_up, max_runtime_sec,
             budget_level, notify, conversation_id, next_run_at, paused_at, idempotency_key, idempotency_hash, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [a.id, userId, a.name, a.instructions, a.leadMemberId, a.enabled, a.schedule.kind, specJson(a.schedule), a.timezone, a.catchUp, a.maxRuntimeSec,
            a.budgetLevel, a.notify, a.conversationId, a.nextRunAt, a.pausedAt, a.idempotencyKey, a.idempotencyHash, a.createdAt, a.updatedAt],
        );
        await writeMembers(q, { ...a, userId });
        await insertMessageQ(q, userId, opening);
      });
      return 'ok';
    } catch (e) {
      if (isUnique(e) && a.idempotencyKey) return 'conflict';
      throw e;
    }
  }

  async updateAssistant(userId: string, a: Assistant): Promise<boolean> {
    return this.#u(userId).tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `UPDATE assistants SET name=$3, instructions=$4, lead_member_id=$5, enabled=$6, schedule_kind=$7, schedule_spec=$8::jsonb, timezone=$9, catch_up=$10,
           max_runtime_sec=$11, budget_level=$12, notify=$13, next_run_at=$14, paused_at=$15, updated_at=$16
         WHERE id=$1 AND user_id=$2 RETURNING id`,
        [a.id, userId, a.name, a.instructions, a.leadMemberId, a.enabled, a.schedule.kind, specJson(a.schedule), a.timezone, a.catchUp,
          a.maxRuntimeSec, a.budgetLevel, a.notify, a.nextRunAt, a.pausedAt, a.updatedAt],
      );
      if (!rows[0]) return false;
      await writeMembers(q, { ...a, userId });
      await q.query('UPDATE conversations SET title = $3, member_ids = $4::text[], updated_at = $5 WHERE id = $1 AND user_id = $2', [
        a.conversationId, userId, a.name, a.members.map((m) => m.memberId), a.updatedAt,
      ]);
      return true;
    });
  }

  async deleteAssistant(userId: string, id: string): Promise<boolean> {
    return this.#u(userId).tx(async (q) => {
      const { rows } = await q.query<{ conversation_id: string }>('DELETE FROM assistants WHERE id = $1 AND user_id = $2 RETURNING conversation_id', [id, userId]);
      if (!rows[0]) return false;
      await q.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [rows[0].conversation_id, userId]);
      return true;
    });
  }

  async insertRun(userId: string, run: AssistantRun): Promise<InsertRunResult> {
    return insertRunQ(this.#u(userId), { ...run, userId });
  }

  async getRun(userId: string, assistantId: string, runId: string): Promise<AssistantRun | null> {
    const { rows } = await this.#u(userId).query<RRow>(`SELECT ${R_COLS} FROM assistant_runs WHERE id = $1 AND assistant_id = $2 AND user_id = $3`, [runId, assistantId, userId]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async findRunByKey(userId: string, assistantId: string, key: string): Promise<AssistantRun | null> {
    const { rows } = await this.#u(userId).query<RRow>(`SELECT ${R_COLS} FROM assistant_runs WHERE assistant_id = $1 AND idempotency_key = $2 AND user_id = $3`, [assistantId, key, userId]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(userId: string, assistantId: string, limit: number, before?: Date): Promise<AssistantRun[]> {
    const { rows } = await this.#u(userId).query<RRow>(
      `SELECT ${R_COLS} FROM assistant_runs WHERE assistant_id = $1 AND user_id = $2 AND ($3::timestamptz IS NULL OR requested_at < $3)
        ORDER BY requested_at DESC, id DESC LIMIT $4`,
      [assistantId, userId, before ?? null, limit],
    );
    return rows.map(toRun);
  }

  async updateRun(userId: string, runId: string, from: readonly RunStatus[], patch: Partial<AssistantRun>): Promise<AssistantRun | null> {
    const cols: Record<string, string> = {
      startedAt: 'started_at', finishedAt: 'finished_at', status: 'status', failureCode: 'failure_code', summary: 'summary',
      usageState: 'usage_state', calls: 'calls', messageIds: 'message_ids', scheduledFor: 'scheduled_for', idempotencyKey: 'idempotency_key', requestedAt: 'requested_at', trigger: 'trigger',
    };
    const sets: string[] = [];
    const params: unknown[] = [runId, userId, [...from]];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}${col === 'message_ids' ? '::uuid[]' : ''}`);
    }
    if (sets.length === 0) return this.#u(userId).query<RRow>(`SELECT ${R_COLS} FROM assistant_runs WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])`, params).then((r) => (r.rows[0] ? toRun(r.rows[0]) : null));
    try {
      const { rows } = await this.#u(userId).query<RRow>(
        `UPDATE assistant_runs SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[]) RETURNING ${R_COLS}`,
        params,
      );
      return rows[0] ? toRun(rows[0]) : null;
    } catch (e) {
      if (isUnique(e)) return null; // 改回 queued 时同一助手已有进行中的运行
      throw e;
    }
  }

  async reserveCall(userId: string, runId: string, since: Date, perRun: number, perDay: number): Promise<number | null> {
    return this.#u(userId).tx(async (q) => {
      // 同一账号的占用排队：拿到锁后这条 UPDATE 用新快照，看得到别的运行刚提交的 +1
      await q.query("SELECT pg_advisory_xact_lock(hashtext('aroomo.assistant_calls'), hashtext($1))", [userId]);
      const { rows } = await q.query<{ calls: number }>(
        `UPDATE assistant_runs SET calls = calls + 1
          WHERE id = $1 AND user_id = $2 AND calls < $3
            AND (SELECT coalesce(sum(calls), 0) FROM assistant_runs WHERE user_id = $2 AND requested_at >= $4) < $5
        RETURNING calls`,
        [runId, userId, perRun, since, perDay],
      );
      return rows[0] ? Number(rows[0].calls) : null;
    });
  }

  async appendStep(userId: string, e: Omit<RunStepEvent, 'seq'>): Promise<RunStepEvent> {
    // seq = 这次运行已有的事件数；同一运行的步骤只由一个执行流写，主键 (run_id, seq) 兜住并发
    const { rows } = await this.#u(userId).query<{ seq: number }>(
      `INSERT INTO run_steps (run_id, user_id, seq, step_no, member_id, action, status, detail, created_at)
       SELECT $1, $2, coalesce(max(seq) + 1, 0), $3, $4, $5, $6, $7, $8 FROM run_steps WHERE run_id = $1 RETURNING seq`,
      [e.runId, userId, e.stepNo, e.memberId, e.action, e.status, e.detail.slice(0, 500), e.createdAt],
    );
    return { ...e, userId, seq: Number(rows[0]!.seq), detail: e.detail.slice(0, 500) };
  }

  async listSteps(userId: string, runId: string): Promise<RunStepEvent[]> {
    const { rows } = await this.#u(userId).query<{
      run_id: string; user_id: string; seq: number; step_no: number; member_id: string | null; action: StepAction; status: StepStatus; detail: string; created_at: Ts;
    }>('SELECT run_id, user_id, seq, step_no, member_id, action, status, detail, created_at FROM run_steps WHERE run_id = $1 AND user_id = $2 ORDER BY seq', [runId, userId]);
    return rows.map((r) => ({
      runId: r.run_id, userId: r.user_id, seq: Number(r.seq), stepNo: Number(r.step_no), memberId: r.member_id, action: r.action, status: r.status, detail: r.detail, createdAt: toDate(r.created_at),
    }));
  }

  async appendMessage(userId: string, m: ConversationMessage): Promise<void> {
    await insertMessageQ(this.#u(userId), userId, m);
  }

  async listMessages(userId: string, conversationId: string, limit: number, afterSeq?: number): Promise<ConversationMessage[]> {
    const { rows } = await this.#u(userId).query<{
      id: string; seq: string | number; conversation_id: string; user_id: string; role: ConversationMessage['role']; member_id: string | null; run_id: string | null; content: string; created_at: Ts;
    }>(
      `SELECT id, seq, conversation_id, user_id, role, member_id, run_id, content, created_at FROM conversation_messages
        WHERE conversation_id = $1 AND user_id = $2 AND seq > $3 ORDER BY seq LIMIT $4`,
      [conversationId, userId, afterSeq ?? 0, limit],
    );
    return rows.map((r) => ({ id: r.id, seq: Number(r.seq), conversationId: r.conversation_id, userId: r.user_id, role: r.role, memberId: r.member_id, runId: r.run_id, content: r.content, createdAt: toDate(r.created_at) }));
  }

  async markRead(userId: string, conversationId: string, at: Date): Promise<boolean> {
    const { rows } = await this.#u(userId).query<{ id: string }>('UPDATE conversations SET read_at = $3 WHERE id = $1 AND user_id = $2 RETURNING id', [conversationId, userId, at]);
    return rows.length > 0;
  }

  async systemActiveRuns(): Promise<Array<{ userId: string; runId: string; assistantId: string }>> {
    const { rows } = await systemScoped(this.db).query<{ user_id: string; id: string; assistant_id: string }>(
      "SELECT user_id, id, assistant_id FROM assistant_runs WHERE status IN ('queued','running')",
    );
    return rows.map((r) => ({ userId: r.user_id, runId: r.id, assistantId: r.assistant_id }));
  }

  async systemDueAssistants(now: Date, limit: number): Promise<Array<{ userId: string; id: string }>> {
    const { rows } = await systemScoped(this.db).query<{ user_id: string; id: string }>(
      'SELECT user_id, id FROM assistants WHERE enabled AND paused_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2',
      [now, limit],
    );
    return rows.map((r) => ({ userId: r.user_id, id: r.id }));
  }

  async claimDue<T>(userId: string, id: string, now: Date, fn: (a: Assistant, tx: ClaimTx) => Promise<T>): Promise<T | null> {
    return this.#u(userId).tx(async (q) => {
      const { rows } = await q.query<ARow>(
        `SELECT ${A_COLS} FROM assistants a WHERE a.id = $1 AND a.user_id = $2 AND a.enabled AND a.paused_at IS NULL AND a.next_run_at <= $3
          FOR UPDATE OF a SKIP LOCKED`,
        [id, userId, now],
      );
      if (!rows[0]) return null;
      return fn(toAssistant(rows[0]), {
        insertRun: (run) => insertRunQ(q, { ...run, userId }),
        setNextRunAt: async (aid, next) => {
          await q.query('UPDATE assistants SET next_run_at = $3 WHERE id = $1 AND user_id = $2', [aid, userId, next]);
        },
      });
    });
  }
}
