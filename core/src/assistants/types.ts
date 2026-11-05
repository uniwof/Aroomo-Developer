/**
 * 助手（指南 v1.1 3.3、7.11、7.12、附录 C；docs/api/design-assistants-v1.md）。
 * 助手 = 任务说明 + 成员组（含组长）+ 计划 + 固定会话 + 运行记录。第一版只给所有者（scope = 'owner'）。
 */
import { FAILURE_TEXT } from '../chat/stream.js';
import type { ChatFailureCode } from '../chat/service.js';

export const SCHEDULE_KINDS = ['manual', 'daily', 'weekly', 'interval'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const CATCH_UPS = ['skip', 'latest'] as const;
export type CatchUp = (typeof CATCH_UPS)[number];
export const BUDGET_LEVELS = ['low', 'mid', 'high'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/** 计划：manual {}；daily {time}；weekly {time, days(1=周一…7=周日)}；interval {everyHours ≥1} */
export type ScheduleSpec =
  | { kind: 'manual' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'interval'; everyHours: number };

export type MemberRole = 'lead' | 'worker';
export interface AssistantMemberLink {
  memberId: string;
  role: MemberRole;
  position: number;
}

export interface Assistant {
  id: string;
  userId: string;
  name: string;
  instructions: string;
  leadMemberId: string | null;
  members: AssistantMemberLink[];
  enabled: boolean;
  schedule: ScheduleSpec;
  timezone: string;
  catchUp: CatchUp;
  maxRuntimeSec: number;
  budgetLevel: BudgetLevel;
  notify: boolean;
  conversationId: string;
  nextRunAt: Date | null;
  pausedAt: Date | null;
  idempotencyKey: string | null;
  idempotencyHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'waiting_confirmation', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** 正在占用「同一助手不并发」名额的状态（与迁移 0027 的部分唯一索引一致） */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running'];

export type RunFailureCode = ChatFailureCode | 'timeout' | 'budget' | 'server_restart' | 'no_member';
export const RUN_FAILURE_TEXT: Record<RunFailureCode, string> = {
  ...FAILURE_TEXT,
  timeout: '超过了每次最长运行时间，已经停下。',
  budget: '这次的额度用完了，已经停下。',
  server_restart: '服务重启，这次运行中断了。',
  no_member: '组长或成员已经被删除或停用，请编辑助手换人。',
};

export type UsageState = 'ample' | 'tight' | 'exhausted';

export interface AssistantRun {
  id: string;
  assistantId: string;
  userId: string;
  trigger: 'manual' | 'schedule';
  scheduledFor: Date | null;
  idempotencyKey: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: RunStatus;
  failureCode: RunFailureCode | null;
  summary: string | null;
  usageState: UsageState | null;
  calls: number;
  messageIds: string[];
}

export type StepAction = 'plan' | 'work' | 'summarize' | 'confirm';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting_confirmation';
/** run_steps 的一行事件（只追加） */
export interface RunStepEvent {
  runId: string;
  userId: string;
  seq: number;
  stepNo: number;
  memberId: string | null;
  action: StepAction;
  status: StepStatus;
  detail: string;
  createdAt: Date;
}

export interface ConversationMessage {
  id: string;
  /** 会话内顺序 / 分页游标（库里生成；写入时不用填） */
  seq?: number;
  conversationId: string;
  userId: string;
  role: 'user' | 'member' | 'system';
  memberId: string | null;
  runId: string | null;
  content: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  userId: string;
  kind: 'chat' | 'assistant';
  title: string;
  memberIds: string[];
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 列表里每个助手附带的摘要 */
export interface AssistantSummary {
  assistant: Assistant;
  lastRun: AssistantRun | null;
  activeRun: AssistantRun | null;
  unread: boolean;
}

export type InsertRunResult = 'ok' | 'conflict';

/**
 * 存储：每个方法都带 userId，只读写这个账号的行（PG 实现每个事务开头设 app.user_id，D206 RLS）。
 * system* 方法跨账号、只读，只给重启恢复和定时执行器第一步用（systemScoped 白名单）。
 */
export interface AssistantStore {
  countAssistants(userId: string): Promise<number>;
  listAssistants(userId: string): Promise<AssistantSummary[]>;
  getAssistant(userId: string, id: string): Promise<Assistant | null>;
  findAssistantByKey(userId: string, key: string): Promise<Assistant | null>;
  /** 原子：会话 + 助手 + 成员组 + 开场白（一个事务，任何一步失败都不留半个助手）；同一个幂等键已存在 → 'conflict' */
  createAssistant(userId: string, a: Assistant, conv: Conversation, opening: ConversationMessage): Promise<InsertRunResult>;
  /** 整行覆盖（含成员组）；不属于 userId → false */
  updateAssistant(userId: string, a: Assistant): Promise<boolean>;
  /** 删除助手（运行、步骤随之删除）和它的固定会话 */
  deleteAssistant(userId: string, id: string): Promise<boolean>;

  /** 插入；撞上任何唯一约束（同助手已有进行中的运行、同幂等键、同计划时刻）→ 'conflict' */
  insertRun(userId: string, run: AssistantRun): Promise<InsertRunResult>;
  getRun(userId: string, assistantId: string, runId: string): Promise<AssistantRun | null>;
  findRunByKey(userId: string, assistantId: string, key: string): Promise<AssistantRun | null>;
  listRuns(userId: string, assistantId: string, limit: number, before?: Date): Promise<AssistantRun[]>;
  /** 比较并交换：只有当前状态在 from 里才改，返回改后的运行 */
  updateRun(userId: string, runId: string, from: readonly RunStatus[], patch: Partial<Omit<AssistantRun, 'id' | 'assistantId' | 'userId'>>): Promise<AssistantRun | null>;
  /**
   * 原子地占一次模型调用：这次运行的 calls < perRun，且本账号 since 之后请求的运行合计 < perDay，才把 calls +1 并返回新值；
   * 不够 → null。同一账号的并发运行在这里排队（PG：按账号的事务级 advisory lock），每天上限不会被并发冲破。
   */
  reserveCall(userId: string, runId: string, since: Date, perRun: number, perDay: number): Promise<number | null>;

  appendStep(userId: string, e: Omit<RunStepEvent, 'seq'>): Promise<RunStepEvent>;
  listSteps(userId: string, runId: string): Promise<RunStepEvent[]>;

  appendMessage(userId: string, m: ConversationMessage): Promise<void>;
  listMessages(userId: string, conversationId: string, limit: number, afterSeq?: number): Promise<ConversationMessage[]>;
  markRead(userId: string, conversationId: string, at: Date): Promise<boolean>;

  /** 跨账号只读：进行中（queued/running）的运行，重启恢复用 */
  systemActiveRuns(): Promise<Array<{ userId: string; runId: string; assistantId: string }>>;
  /** 跨账号只读：到期的助手（定时执行器第一步） */
  systemDueAssistants(now: Date, limit: number): Promise<Array<{ userId: string; id: string }>>;
  /**
   * 定时执行器第二步：在这个账号的范围里锁住到期助手（FOR UPDATE SKIP LOCKED），fn 在同一个事务里决定插哪些运行、下次时间。
   * 别人已锁住、已不到期、已停用 / 暂停 → fn 不会被调用，返回 null。
   */
  claimDue<T>(userId: string, id: string, now: Date, fn: (a: Assistant, tx: ClaimTx) => Promise<T>): Promise<T | null>;
}

export interface ClaimTx {
  insertRun(run: AssistantRun): Promise<InsertRunResult>;
  setNextRunAt(id: string, next: Date | null): Promise<void>;
}
