import type {
  ExecutorRecord,
  ExecutorStore,
  TakeoverRecord,
  TaskRecord,
} from "./types.js";

const cp = (t: TaskRecord): TaskRecord => ({
  ...t,
  secrets: t.secrets.map((s) => ({ ...s })),
  options: { ...t.options },
});

export class MemoryExecutorStore implements ExecutorStore {
  readonly #ex = new Map<string, ExecutorRecord>();
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #tk = new Map<string, TakeoverRecord>();

  async insertTakeover(t: TakeoverRecord) {
    this.#tk.set(t.id, { ...t });
  }
  async getTakeover(userId: string, taskId: string, id: string) {
    const t = this.#tk.get(id);
    return t && t.userId === userId && t.taskId === taskId ? { ...t } : null;
  }
  async listTakeovers(userId: string, taskId: string) {
    return [...this.#tk.values()]
      .filter((t) => t.userId === userId && t.taskId === taskId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => ({ ...t }));
  }
  async resolveTakeover(
    userId: string,
    taskId: string,
    id: string,
    status: "resolved" | "cancelled",
    note: string | null,
    now: Date,
  ) {
    const t = this.#tk.get(id);
    if (!t || t.userId !== userId || t.taskId !== taskId) return null;
    if (t.status !== "pending") return null;
    Object.assign(t, { status, note, resolvedAt: now });
    return { ...t };
  }

  async upsertExecutor(r: ExecutorRecord): Promise<ExecutorRecord> {
    for (const e of this.#ex.values()) {
      if (e.userId === r.userId && e.clientId === r.clientId) {
        Object.assign(e, {
          deviceName: r.deviceName,
          platform: r.platform,
          version: r.version,
          adapters: [...r.adapters],
          lastSeenAt: r.lastSeenAt,
        });
        return { ...e };
      }
    }
    this.#ex.set(r.id, { ...r, adapters: [...r.adapters] });
    return { ...r };
  }
  async getExecutor(userId: string, id: string) {
    const e = this.#ex.get(id);
    return e && e.userId === userId ? { ...e } : null;
  }
  async touchExecutor(userId: string, id: string, at: Date) {
    const e = this.#ex.get(id);
    if (e && e.userId === userId) e.lastSeenAt = at;
  }
  async listExecutors(userId: string) {
    return [...this.#ex.values()]
      .filter((e) => e.userId === userId)
      .map((e) => ({ ...e }));
  }
  async insertTask(t: TaskRecord) {
    this.#tasks.set(t.id, cp(t));
  }
  async getTask(userId: string, id: string) {
    const t = this.#tasks.get(id);
    return t && t.userId === userId ? cp(t) : null;
  }
  async listTasks(userId: string, limit: number) {
    return [...this.#tasks.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(cp);
  }
  async claim(
    userId: string,
    executorId: string,
    kinds: string[] | null,
    now: Date,
    leaseUntil: Date,
  ) {
    for (const t of this.#tasks.values()) {
      if (
        t.userId === userId &&
        t.status === "running" &&
        t.leaseExpiresAt &&
        t.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        Object.assign(t, {
          status: t.cancelRequested ? "cancelled" : "queued",
          executorId: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });
      }
    }
    const next = [...this.#tasks.values()]
      .filter(
        (t) =>
          t.userId === userId &&
          t.status === "queued" &&
          (!kinds || kinds.includes(t.kind)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!next) return null;
    Object.assign(next, {
      status: "running",
      executorId,
      leaseExpiresAt: leaseUntil,
      updatedAt: now,
    });
    return cp(next);
  }
  #held(
    userId: string,
    id: string,
    executorId: string,
    now: Date,
  ): TaskRecord | null {
    const t = this.#tasks.get(id);
    if (
      !t ||
      t.userId !== userId ||
      t.status !== "running" ||
      t.executorId !== executorId
    )
      return null;
    if (!t.leaseExpiresAt || t.leaseExpiresAt.getTime() <= now.getTime())
      return null;
    return t;
  }
  async sweep(now: Date, queuedBefore: Date) {
    let requeued = 0;
    let expired = 0;
    for (const t of this.#tasks.values()) {
      if (t.status === "running" && t.leaseExpiresAt && t.leaseExpiresAt.getTime() <= now.getTime()) {
        Object.assign(t, { status: t.cancelRequested ? "cancelled" : "queued", executorId: null, leaseExpiresAt: null, updatedAt: now });
        requeued++;
      } else if (t.status === "queued" && t.createdAt.getTime() < queuedBefore.getTime()) {
        Object.assign(t, { status: "failed", resultError: "NO_EXECUTOR", resultSummary: "超过时限没有执行员领取，已过期", updatedAt: now });
        expired++;
      }
    }
    return { requeued, expired };
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
    const t = this.#held(userId, id, executorId, now);
    if (!t) return null;
    Object.assign(t, {
      leaseExpiresAt: leaseUntil,
      lastStage: stage,
      lastMessage: message,
      updatedAt: now,
    });
    return cp(t);
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
    const t = this.#held(userId, id, executorId, now);
    if (!t) return null;
    Object.assign(t, {
      status,
      resultSummary: summary,
      resultError: error,
      leaseExpiresAt: null,
      updatedAt: now,
    });
    return cp(t);
  }
  async cancel(userId: string, id: string, now: Date) {
    const t = this.#tasks.get(id);
    if (!t || t.userId !== userId) return null;
    if (t.status === "queued")
      Object.assign(t, { status: "cancelled", updatedAt: now });
    else if (t.status === "running")
      Object.assign(t, { cancelRequested: true, updatedAt: now });
    return cp(t);
  }
}
