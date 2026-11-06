/** 内存实现（开发 / 演示 / 测试）：行为与 PG 实现一致，含唯一约束与比较并交换。 */
import {
  ACTIVE_RUN_STATUSES,
  type Assistant,
  type AssistantRun,
  type AssistantStore,
  type AssistantSummary,
  type ClaimTx,
  type Conversation,
  type ConversationMessage,
  type InsertRunResult,
  type RunStatus,
  type RunStepEvent,
} from './types.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAssistantStore implements AssistantStore {
  readonly #assistants = new Map<string, Assistant>();
  readonly #convs = new Map<string, Conversation>();
  readonly #messages: ConversationMessage[] = [];
  readonly #runs = new Map<string, AssistantRun>();
  readonly #steps: RunStepEvent[] = [];
  readonly #locked = new Set<string>();
  #seq = 0;

  #own(userId: string, id: string): Assistant | null {
    const a = this.#assistants.get(id);
    return a && a.userId === userId ? a : null;
  }

  async countAssistants(userId: string): Promise<number> {
    return [...this.#assistants.values()].filter((a) => a.userId === userId).length;
  }

  async listAssistants(userId: string): Promise<AssistantSummary[]> {
    const out: AssistantSummary[] = [];
    for (const a of this.#assistants.values()) {
      if (a.userId !== userId) continue;
      const runs = [...this.#runs.values()].filter((r) => r.assistantId === a.id).sort((x, y) => y.requestedAt.getTime() - x.requestedAt.getTime());
      const conv = this.#convs.get(a.conversationId);
      const last = this.#messages.filter((m) => m.conversationId === a.conversationId).at(-1);
      out.push({
        assistant: clone(a),
        lastRun: runs[0] ? clone(runs[0]) : null,
        activeRun: clone(runs.find((r) => ACTIVE_RUN_STATUSES.includes(r.status)) ?? null),
        unread: !!last && (!conv?.readAt || last.createdAt.getTime() > conv.readAt.getTime()),
      });
    }
    return out;
  }

  async getAssistant(userId: string, id: string): Promise<Assistant | null> {
    const a = this.#own(userId, id);
    return a ? clone(a) : null;
  }

  async findAssistantByKey(userId: string, key: string): Promise<Assistant | null> {
    const a = [...this.#assistants.values()].find((x) => x.userId === userId && x.idempotencyKey === key);
    return a ? clone(a) : null;
  }

  async createAssistant(userId: string, a: Assistant, conv: Conversation, opening: ConversationMessage): Promise<InsertRunResult> {
    if (a.userId !== userId || conv.userId !== userId || opening.userId !== userId) throw new Error('user mismatch');
    if (opening.conversationId !== conv.id) throw new Error('foreign key violation');
    if (a.idempotencyKey && (await this.findAssistantByKey(userId, a.idempotencyKey))) return 'conflict';
    // 先全部校验完再一起写：不留半个助手
    this.#convs.set(conv.id, clone(conv));
    this.#assistants.set(a.id, clone(a));
    this.#seq++;
    this.#messages.push({ ...clone(opening), seq: this.#seq });
    return 'ok';
  }

  async updateAssistant(userId: string, a: Assistant): Promise<boolean> {
    if (!this.#own(userId, a.id) || a.userId !== userId) return false;
    this.#assistants.set(a.id, clone(a));
    return true;
  }

  async deleteAssistant(userId: string, id: string): Promise<boolean> {
    const a = this.#own(userId, id);
    if (!a) return false;
    this.#assistants.delete(id);
    for (const r of [...this.#runs.values()]) if (r.assistantId === id) this.#runs.delete(r.id);
    this.#convs.delete(a.conversationId);
    for (let i = this.#messages.length - 1; i >= 0; i--) if (this.#messages[i]!.conversationId === a.conversationId) this.#messages.splice(i, 1);
    return true;
  }

  async insertRun(userId: string, run: AssistantRun): Promise<InsertRunResult> {
    if (!this.#own(userId, run.assistantId) || run.userId !== userId) throw new Error('foreign key violation');
    const same = [...this.#runs.values()].filter((r) => r.assistantId === run.assistantId);
    if (ACTIVE_RUN_STATUSES.includes(run.status) && same.some((r) => ACTIVE_RUN_STATUSES.includes(r.status))) return 'conflict';
    if (run.status === 'waiting_confirmation' && same.some((r) => r.status === 'waiting_confirmation')) return 'conflict';
    if (run.idempotencyKey && same.some((r) => r.idempotencyKey === run.idempotencyKey)) return 'conflict';
    if (run.scheduledFor && same.some((r) => r.scheduledFor?.getTime() === run.scheduledFor!.getTime())) return 'conflict';
    this.#runs.set(run.id, clone(run));
    return 'ok';
  }

  async getRun(userId: string, assistantId: string, runId: string): Promise<AssistantRun | null> {
    const r = this.#runs.get(runId);
    return r && r.userId === userId && r.assistantId === assistantId ? clone(r) : null;
  }

  async findRunByKey(userId: string, assistantId: string, key: string): Promise<AssistantRun | null> {
    const r = [...this.#runs.values()].find((x) => x.userId === userId && x.assistantId === assistantId && x.idempotencyKey === key);
    return r ? clone(r) : null;
  }

  async listRuns(userId: string, assistantId: string, limit: number, before?: Date): Promise<AssistantRun[]> {
    return [...this.#runs.values()]
      .filter((r) => r.userId === userId && r.assistantId === assistantId && (!before || r.requestedAt.getTime() < before.getTime()))
      .sort((x, y) => y.requestedAt.getTime() - x.requestedAt.getTime() || y.id.localeCompare(x.id))
      .slice(0, limit)
      .map(clone);
  }

  async updateRun(userId: string, runId: string, from: readonly RunStatus[], patch: Partial<AssistantRun>): Promise<AssistantRun | null> {
    const r = this.#runs.get(runId);
    if (!r || r.userId !== userId || !from.includes(r.status)) return null;
    const next = { ...r, ...clone(patch) };
    if (ACTIVE_RUN_STATUSES.includes(next.status) && !ACTIVE_RUN_STATUSES.includes(r.status)) {
      if ([...this.#runs.values()].some((x) => x.id !== r.id && x.assistantId === r.assistantId && ACTIVE_RUN_STATUSES.includes(x.status))) return null;
    }
    if (next.status === 'waiting_confirmation' && r.status !== 'waiting_confirmation') {
      if ([...this.#runs.values()].some((x) => x.id !== r.id && x.assistantId === r.assistantId && x.status === 'waiting_confirmation')) return null;
    }
    this.#runs.set(runId, next);
    return clone(next);
  }

  async reserveCall(userId: string, runId: string, since: Date, perRun: number, perDay: number): Promise<number | null> {
    // 同步完成（中间没有 await）：单线程下天然原子
    const r = this.#runs.get(runId);
    if (!r || r.userId !== userId || r.calls >= perRun) return null;
    const day = [...this.#runs.values()].filter((x) => x.userId === userId && x.requestedAt.getTime() >= since.getTime()).reduce((n, x) => n + x.calls, 0);
    if (day >= perDay) return null;
    r.calls++;
    return r.calls;
  }

  async appendStep(userId: string, e: Omit<RunStepEvent, 'seq'>): Promise<RunStepEvent> {
    const r = this.#runs.get(e.runId);
    if (!r || r.userId !== userId || e.userId !== userId) throw new Error('foreign key violation');
    const seq = this.#steps.filter((s) => s.runId === e.runId).length;
    const row = { ...clone(e), seq };
    this.#steps.push(row);
    return clone(row);
  }

  async listSteps(userId: string, runId: string): Promise<RunStepEvent[]> {
    if (!this.#runs.has(runId)) return [];
    return this.#steps.filter((s) => s.runId === runId && s.userId === userId).map(clone);
  }

  async workingMembers(userId: string): Promise<Array<{ memberId: string; runId: string; since: Date }>> {
    const latest = new Map<string, RunStepEvent>();
    for (const s of this.#steps) {
      if (s.userId !== userId || this.#runs.get(s.runId)?.status !== 'running') continue;
      const k = `${s.runId}:${s.stepNo}`;
      const prev = latest.get(k);
      if (!prev || prev.seq < s.seq) latest.set(k, s);
    }
    const out = new Map<string, { memberId: string; runId: string; since: Date }>();
    for (const s of latest.values()) {
      if (s.status !== 'running' || !s.memberId) continue;
      const prev = out.get(s.memberId);
      if (!prev || s.createdAt < prev.since) out.set(s.memberId, { memberId: s.memberId, runId: s.runId, since: new Date(s.createdAt) });
    }
    return [...out.values()];
  }

  async appendMessage(userId: string, m: ConversationMessage): Promise<void> {
    const c = this.#convs.get(m.conversationId);
    if (!c || c.userId !== userId || m.userId !== userId) throw new Error('foreign key violation');
    this.#seq++;
    this.#messages.push({ ...clone(m), seq: this.#seq });
  }

  async listMessages(userId: string, conversationId: string, limit: number, afterSeq?: number): Promise<ConversationMessage[]> {
    return this.#messages
      .filter((m) => m.userId === userId && m.conversationId === conversationId && m.seq! > (afterSeq ?? 0))
      .slice(0, limit)
      .map(clone);
  }

  async markRead(userId: string, conversationId: string, at: Date): Promise<boolean> {
    const c = this.#convs.get(conversationId);
    if (!c || c.userId !== userId) return false;
    c.readAt = new Date(at);
    return true;
  }

  async findWaitingRun(userId: string, assistantId: string): Promise<AssistantRun | null> {
    const r = [...this.#runs.values()].find((x) => x.userId === userId && x.assistantId === assistantId && x.status === 'waiting_confirmation');
    return r ? clone(r) : null;
  }

  async systemStaleWaitingRuns(before: Date, limit: number): Promise<Array<{ userId: string; runId: string; assistantId: string }>> {
    const since = (r: AssistantRun) =>
      this.#steps.filter((s) => s.runId === r.id && s.action === 'confirm' && s.status === 'waiting_confirmation').at(-1)?.createdAt ?? r.requestedAt;
    return [...this.#runs.values()]
      .filter((r) => r.status === 'waiting_confirmation' && since(r).getTime() < before.getTime())
      .sort((x, y) => x.requestedAt.getTime() - y.requestedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ userId: r.userId, runId: r.id, assistantId: r.assistantId }));
  }

  async systemActiveRuns(): Promise<Array<{ userId: string; runId: string; assistantId: string }>> {
    return [...this.#runs.values()].filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).map((r) => ({ userId: r.userId, runId: r.id, assistantId: r.assistantId }));
  }

  async systemDueAssistants(now: Date, limit: number): Promise<Array<{ userId: string; id: string }>> {
    return [...this.#assistants.values()]
      .filter((a) => a.enabled && !a.pausedAt && a.nextRunAt && a.nextRunAt.getTime() <= now.getTime())
      .sort((x, y) => x.nextRunAt!.getTime() - y.nextRunAt!.getTime())
      .slice(0, limit)
      .map((a) => ({ userId: a.userId, id: a.id }));
  }

  async claimDue<T>(userId: string, id: string, now: Date, fn: (a: Assistant, tx: ClaimTx) => Promise<T>): Promise<T | null> {
    const a = this.#own(userId, id);
    if (!a || this.#locked.has(id) || !a.enabled || a.pausedAt || !a.nextRunAt || a.nextRunAt.getTime() > now.getTime()) return null;
    this.#locked.add(id);
    try {
      return await fn(clone(a), {
        insertRun: (run) => this.insertRun(userId, run),
        hasWaitingRun: async (aid) => (await this.findWaitingRun(userId, aid)) !== null,
        setNextRunAt: async (aid, next) => {
          const x = this.#own(userId, aid);
          if (x) x.nextRunAt = next ? new Date(next) : null;
        },
      });
    } finally {
      this.#locked.delete(id);
    }
  }
}
