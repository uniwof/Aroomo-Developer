export const TASK_KINDS = ["checkin", "login", "signup", "browse"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ExecutorRecord {
  id: string;
  userId: string;
  clientId: string;
  deviceName: string;
  platform: string;
  version: string;
  adapters: string[];
  createdAt: Date;
  lastSeenAt: Date;
}

export interface TaskSecretRef {
  secretId: string;
  field: string;
}

export interface TaskRecord {
  id: string;
  userId: string;
  kind: TaskKind;
  site: string;
  instruction: string;
  secrets: TaskSecretRef[];
  options: Record<string, unknown>;
  status: TaskStatus;
  executorId: string | null;
  leaseExpiresAt: Date | null;
  cancelRequested: boolean;
  lastStage: string | null;
  lastMessage: string | null;
  resultSummary: string | null;
  resultError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutorStore {
  /** 同一 (user, client) 重复 hello 返回同一条记录 */
  upsertExecutor(
    r: Omit<ExecutorRecord, "lastSeenAt"> & { lastSeenAt: Date },
  ): Promise<ExecutorRecord>;
  getExecutor(userId: string, id: string): Promise<ExecutorRecord | null>;
  touchExecutor(userId: string, id: string, at: Date): Promise<void>;
  listExecutors(userId: string): Promise<ExecutorRecord[]>;
  insertTask(t: TaskRecord): Promise<void>;
  getTask(userId: string, id: string): Promise<TaskRecord | null>;
  listTasks(userId: string, limit: number): Promise<TaskRecord[]>;
  /** 原子领取：先把租约过期的 running 退回 queued，再领最早的 queued。只看这个用户的。 */
  claim(
    userId: string,
    executorId: string,
    kinds: string[] | null,
    now: Date,
    leaseUntil: Date,
  ): Promise<TaskRecord | null>;
  /** 只有当前持有租约的执行员能改；返回更新后的任务，不满足条件返回 null */
  renew(
    userId: string,
    id: string,
    executorId: string,
    now: Date,
    leaseUntil: Date,
    stage: string,
    message: string,
  ): Promise<TaskRecord | null>;
  finish(
    userId: string,
    id: string,
    executorId: string,
    status: "succeeded" | "failed" | "cancelled",
    summary: string,
    error: string | null,
    now: Date,
  ): Promise<TaskRecord | null>;
  /** 所有者取消：queued 直接变 cancelled；running 标记 cancel_requested */
  cancel(userId: string, id: string, now: Date): Promise<TaskRecord | null>;
}
