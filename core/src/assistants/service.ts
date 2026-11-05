/**
 * 助手业务（docs/api/design-assistants-v1.md）：增删改查、预览、暂停 / 继续、立即运行（交给 runner）、运行记录、固定会话。
 * 所有方法都带 userId（= scopeOf(req)）；第一版只有所有者（'owner'）能走到这里，路由层先挡掉别人。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import type { ConfirmCtx, ConfirmService } from '../confirm/confirm.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import type { Member, MemberStore } from '../members/types.js';
import { isValidTimezone, nextRunAt, parseSchedule, type ScheduleInput, scheduleText, shortWhen } from './schedule.js';
import {
  ACTIVE_RUN_STATUSES,
  type Assistant,
  type AssistantMemberLink,
  type AssistantRun,
  type AssistantStore,
  type AssistantSummary,
  BUDGET_LEVELS,
  type BudgetLevel,
  CATCH_UPS,
  type CatchUp,
  type ConversationMessage,
  type RunStepEvent,
} from './types.js';

export const MAX_ASSISTANTS_PER_ACCOUNT = 20;
export const MAX_MEMBERS_PER_ASSISTANT = 8;
export const DRAFT_PART = 'data-aroomo-assistant-draft';

export interface AssistantInput {
  name: string;
  instructions: string;
  members: string[];
  leadMemberId?: string;
  schedule: ScheduleInput;
  timezone?: string;
  catchUp?: CatchUp;
  maxRuntimeSec?: number;
  budgetLevel?: BudgetLevel;
  notify?: boolean;
  enabled?: boolean;
}
export type AssistantPatch = Partial<AssistantInput>;

/** 交给执行器的接口（runner.ts 实现）；service 不直接调模型 */
export interface RunLauncher {
  start(userId: string, runId: string): void;
  cancel(userId: string, runId: string): boolean;
}

export interface AssistantServiceDeps {
  store: AssistantStore;
  membersFor: (userId: string) => MemberStore;
  confirm: ConfirmService;
  now: () => Date;
  /** 默认时区（CORE_TIMEZONE） */
  timezone: string;
}

/** 在职、启用、没进回收站的成员才能进成员组 */
export const usableMember = (m: Member): boolean => m.enabled && m.status === 'active' && !m.deletedAt;

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

export function runJson(r: AssistantRun) {
  return {
    id: r.id,
    assistantId: r.assistantId,
    trigger: r.trigger,
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
    requestedAt: r.requestedAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    status: r.status,
    failureCode: r.failureCode,
    summary: r.summary,
    usageState: r.usageState,
    messageIds: r.messageIds,
  };
}

/** 步骤事件折叠成每一步的当前状态（X-03 任务卡） */
export function foldSteps(events: RunStepEvent[]) {
  const by = new Map<number, { stepNo: number; memberId: string | null; action: string; status: string; detail: string; startedAt: string; updatedAt: string }>();
  for (const e of events) {
    const cur = by.get(e.stepNo);
    by.set(e.stepNo, {
      stepNo: e.stepNo,
      memberId: e.memberId,
      action: e.action,
      status: e.status,
      // 付费确认步骤开头的成员组指纹只给执行器用，不给界面
      detail: e.action === 'confirm' ? e.detail.replace(/^\[set:[0-9a-f]{16}\] /, '') : e.detail,
      startedAt: cur?.startedAt ?? e.createdAt.toISOString(),
      updatedAt: e.createdAt.toISOString(),
    });
  }
  return [...by.values()].sort((a, b) => a.stepNo - b.stepNo);
}

export function messageJson(m: ConversationMessage) {
  return { id: m.id, seq: m.seq ?? null, role: m.role, memberId: m.memberId, runId: m.runId, content: m.content, createdAt: m.createdAt.toISOString() };
}

export function assistantJson(a: Assistant, extra?: Omit<AssistantSummary, 'assistant'>) {
  const status = a.pausedAt ? 'paused' : extra?.activeRun ? 'running' : extra?.lastRun?.status === 'waiting_confirmation' ? 'waiting' : 'normal';
  return {
    id: a.id,
    name: a.name,
    instructions: a.instructions,
    leadMemberId: a.leadMemberId,
    members: a.members,
    enabled: a.enabled,
    schedule: { ...a.schedule, text: scheduleText(a.schedule) },
    timezone: a.timezone,
    catchUp: a.catchUp,
    maxRuntimeSec: a.maxRuntimeSec,
    budgetLevel: a.budgetLevel,
    notify: a.notify,
    conversationId: a.conversationId,
    nextRunAt: a.nextRunAt?.toISOString() ?? null,
    pausedAt: a.pausedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    ...(extra
      ? { status, unread: extra.unread, lastRun: extra.lastRun ? runJson(extra.lastRun) : null, activeRunId: extra.activeRun?.id ?? null }
      : {}),
  };
}

/** 指南 3.3 排序：等确认、失败在最上，其余按下次运行时间（没有的排后），再按创建时间 */
function rank(s: AssistantSummary): number {
  const st = s.lastRun?.status;
  return st === 'waiting_confirmation' ? 0 : st === 'failed' ? 1 : 2;
}

export class AssistantService {
  #launcher: RunLauncher | null = null;
  constructor(private readonly d: AssistantServiceDeps) {}

  setLauncher(l: RunLauncher): void {
    this.#launcher = l;
  }

  /** 校验并规范化（建、改、预览共用）。返回不含 id 的字段 */
  async #normalize(userId: string, input: AssistantInput) {
    const name = input.name.trim();
    if (!name || Array.from(name).length > 60) throw badRequest('请给助手起个名字（最多 60 个字）', 'INVALID_NAME');
    const instructions = input.instructions.trim();
    if (Array.from(instructions).length < 10) throw badRequest('任务说明再写具体一点（至少 10 个字）', 'INVALID_INSTRUCTIONS');
    if (Array.from(instructions).length > 4000) throw badRequest('任务说明最多 4000 个字', 'INVALID_INSTRUCTIONS');
    const ids = [...new Set(input.members)];
    if (ids.length === 0) throw badRequest('至少选 1 位成员', 'INVALID_MEMBERS');
    if (ids.length > MAX_MEMBERS_PER_ASSISTANT) throw badRequest(`一个助手最多 ${MAX_MEMBERS_PER_ASSISTANT} 位成员`, 'INVALID_MEMBERS');
    const store = this.d.membersFor(userId);
    for (const id of ids) {
      const m = await store.get(id);
      // 别人的成员与不存在的成员一样（看不出存在）
      if (!m || !usableMember(m)) throw badRequest('有成员不存在或已停用，请重新选择', 'INVALID_MEMBERS');
    }
    const lead = input.leadMemberId ?? ids[0]!;
    if (!ids.includes(lead)) throw badRequest('组长必须是选中的成员之一', 'INVALID_LEAD');
    const members: AssistantMemberLink[] = ids.map((memberId, position) => ({ memberId, role: memberId === lead ? 'lead' : 'worker', position }));
    const timezone = input.timezone ?? this.d.timezone;
    if (!isValidTimezone(timezone)) throw badRequest('时区不合法', 'INVALID_TIMEZONE');
    const schedule = parseSchedule(input.schedule);
    const catchUp = input.catchUp ?? 'skip';
    if (!CATCH_UPS.includes(catchUp)) throw badRequest('「错过的运行」只能是跳过或补跑最近一次', 'INVALID_CATCH_UP');
    const maxRuntimeSec = input.maxRuntimeSec ?? 600;
    if (!Number.isInteger(maxRuntimeSec) || maxRuntimeSec < 60 || maxRuntimeSec > 1800) throw badRequest('每次最长运行 1–30 分钟', 'INVALID_RUNTIME');
    const budgetLevel = input.budgetLevel ?? 'low';
    if (!BUDGET_LEVELS.includes(budgetLevel)) throw badRequest('额度档只能是低 / 中 / 高', 'INVALID_BUDGET');
    return { name, instructions, leadMemberId: lead, members, timezone, schedule, catchUp, maxRuntimeSec, budgetLevel, notify: input.notify ?? true, enabled: input.enabled ?? true };
  }

  #next(a: Pick<Assistant, 'enabled' | 'pausedAt' | 'schedule' | 'timezone'>): Date | null {
    return a.enabled && !a.pausedAt ? nextRunAt(a.schedule, a.timezone, this.d.now()) : null;
  }

  async #mustGet(userId: string, id: string): Promise<Assistant> {
    const a = await this.d.store.getAssistant(userId, id);
    if (!a) throw notFound('找不到这个助手');
    return a;
  }

  /** 7.11 实时那一行 + X-15 草稿卡：只校验和推算，不落库 */
  async preview(userId: string, input: AssistantInput) {
    const n = await this.#normalize(userId, input);
    const next = this.#next({ ...n, pausedAt: null });
    const draft = {
      name: n.name,
      instructions: n.instructions,
      members: n.members.map((m) => m.memberId),
      leadMemberId: n.leadMemberId,
      schedule: input.schedule,
      timezone: n.timezone,
      catchUp: n.catchUp,
      maxRuntimeSec: n.maxRuntimeSec,
      budgetLevel: n.budgetLevel,
      notify: n.notify,
      enabled: n.enabled,
    };
    return {
      scheduleText: scheduleText(n.schedule),
      nextRunAt: next?.toISOString() ?? null,
      nextRunText: next ? `下次运行：${shortWhen(next, n.timezone)}` : '只在你叫它时运行',
      part: { type: DRAFT_PART, data: { ...draft, scheduleText: scheduleText(n.schedule), nextRunAt: next?.toISOString() ?? null } },
    };
  }

  async list(userId: string) {
    const all = await this.d.store.listAssistants(userId);
    all.sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (x.assistant.nextRunAt?.getTime() ?? Infinity) - (y.assistant.nextRunAt?.getTime() ?? Infinity) ||
        x.assistant.createdAt.getTime() - y.assistant.createdAt.getTime(),
    );
    return all.map((s) => assistantJson(s.assistant, s));
  }

  async get(userId: string, id: string) {
    const s = (await this.d.store.listAssistants(userId)).find((x) => x.assistant.id === id);
    if (!s) throw notFound('找不到这个助手');
    return assistantJson(s.assistant, s);
  }

  async create(userId: string, input: AssistantInput, idempotencyKey: string | undefined, audit: AuditFn): Promise<{ assistant: Assistant; created: boolean }> {
    const hash = idempotencyKey ? createHash('sha256').update(stable(input)).digest('hex') : null;
    if (idempotencyKey) {
      const prev = await this.d.store.findAssistantByKey(userId, idempotencyKey);
      if (prev) return this.#replay(prev, hash!);
    }
    if ((await this.d.store.countAssistants(userId)) >= MAX_ASSISTANTS_PER_ACCOUNT) {
      throw conflict(`每个账号最多 ${MAX_ASSISTANTS_PER_ACCOUNT} 个助手`, 'ASSISTANT_LIMIT');
    }
    const n = await this.#normalize(userId, input);
    const now = this.d.now();
    const id = randomUUID();
    const a: Assistant = {
      id,
      userId,
      ...n,
      conversationId: randomUUID(),
      nextRunAt: this.#next({ ...n, pausedAt: null }),
      pausedAt: null,
      idempotencyKey: idempotencyKey ?? null,
      idempotencyHash: hash,
      createdAt: now,
      updatedAt: now,
    };
    // 7.11：建好以后固定会话的第一条消息由组长说；和助手同一个事务写（不会有缺开场白的助手）
    // 「每天 09:00 开始」：时间后留空格，「每 3 小时开始」不加
    const when = scheduleText(a.schedule);
    const intro = a.nextRunAt
      ? `我是 ${a.name}，${when}${/\d$/.test(when) ? ' ' : ''}开始，下次 ${shortWhen(a.nextRunAt, a.timezone)}。`
      : `我是 ${a.name}，你叫我时我就开始。`;
    const res = await this.d.store.createAssistant(
      userId,
      a,
      { id: a.conversationId, userId, kind: 'assistant', title: a.name, memberIds: a.members.map((m) => m.memberId), readAt: null, createdAt: now, updatedAt: now },
      { id: randomUUID(), conversationId: a.conversationId, userId, role: 'member', memberId: a.leadMemberId, runId: null, content: intro, createdAt: now },
    );
    if (res === 'conflict') {
      const prev = await this.d.store.findAssistantByKey(userId, idempotencyKey!);
      if (prev) return this.#replay(prev, hash!);
      throw conflict('请求冲突，请重试', 'CONFLICT');
    }
    await audit('assistant.create', { type: 'assistant', id }, 'ok', `members=${a.members.length} schedule=${a.schedule.kind}`);
    return { assistant: a, created: true };
  }

  #replay(prev: Assistant, hash: string): { assistant: Assistant; created: boolean } {
    if (prev.idempotencyHash !== hash) throw conflict('同一个幂等键已经用在不同的内容上', 'IDEMPOTENCY_MISMATCH');
    return { assistant: prev, created: false };
  }

  async update(userId: string, id: string, patch: AssistantPatch, audit: AuditFn): Promise<Assistant> {
    const cur = await this.#mustGet(userId, id);
    const merged: AssistantInput = {
      name: patch.name ?? cur.name,
      instructions: patch.instructions ?? cur.instructions,
      members: patch.members ?? cur.members.map((m) => m.memberId),
      // 换了成员组但没指定组长：原组长还在就留着，不在就由第一位当
      ...(patch.leadMemberId !== undefined
        ? { leadMemberId: patch.leadMemberId }
        : cur.leadMemberId && (patch.members ?? [cur.leadMemberId]).includes(cur.leadMemberId)
          ? { leadMemberId: cur.leadMemberId }
          : {}),
      schedule: patch.schedule ?? { ...cur.schedule },
      timezone: patch.timezone ?? cur.timezone,
      catchUp: patch.catchUp ?? cur.catchUp,
      maxRuntimeSec: patch.maxRuntimeSec ?? cur.maxRuntimeSec,
      budgetLevel: patch.budgetLevel ?? cur.budgetLevel,
      notify: patch.notify ?? cur.notify,
      enabled: patch.enabled ?? cur.enabled,
    };
    const n = await this.#normalize(userId, merged);
    const scheduleChanged = stable(n.schedule) !== stable(cur.schedule) || n.timezone !== cur.timezone || n.enabled !== cur.enabled;
    const next: Assistant = {
      ...cur,
      ...n,
      // 每次保存计划时算好 next_run_at（v2.1 阶段 2）；计划没变就保留，不打乱已排好的下一次
      nextRunAt: scheduleChanged || !cur.nextRunAt ? this.#next({ ...n, pausedAt: cur.pausedAt }) : cur.nextRunAt,
      updatedAt: this.d.now(),
    };
    if (!(await this.d.store.updateAssistant(userId, next))) throw notFound('找不到这个助手');
    await audit('assistant.update', { type: 'assistant', id }, 'ok', Object.keys(patch).sort().join(','));
    return next;
  }

  /** 删除：不可逆（会话和运行记录一起删），走统一确认（D63）。 */
  async delete(userId: string, id: string, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    const a = await this.#mustGet(userId, id);
    await this.d.confirm.require(
      {
        scope: `assistants:delete:${id}`,
        kind: 'irreversible',
        title: `删除助手「${a.name}」`,
        consequences: ['删除以后不再运行。', '会话和运行记录一起删除，找不回来。'],
        confirmLabel: '删除',
      },
      ctx,
      audit,
    );
    const runs = await this.d.store.listRuns(userId, id, 100);
    for (const r of runs) if (ACTIVE_RUN_STATUSES.includes(r.status)) this.#launcher?.cancel(userId, r.id);
    if (!(await this.d.store.deleteAssistant(userId, id))) throw notFound('找不到这个助手');
    await audit('assistant.delete', { type: 'assistant', id }, 'ok');
  }

  async pause(userId: string, id: string, audit: AuditFn): Promise<Assistant> {
    const a = await this.#mustGet(userId, id);
    if (a.pausedAt) return a;
    const next = { ...a, pausedAt: this.d.now(), nextRunAt: null, updatedAt: this.d.now() };
    await this.d.store.updateAssistant(userId, next);
    await audit('assistant.pause', { type: 'assistant', id }, 'ok');
    return next;
  }

  async resume(userId: string, id: string, audit: AuditFn): Promise<Assistant> {
    const a = await this.#mustGet(userId, id);
    if (!a.pausedAt) return a;
    const next = { ...a, pausedAt: null, updatedAt: this.d.now() };
    next.nextRunAt = this.#next(next);
    await this.d.store.updateAssistant(userId, next);
    await audit('assistant.resume', { type: 'assistant', id }, 'ok');
    return next;
  }

  /**
   * 立即运行（7.12）：不影响下一次定时。幂等键重复 → 返回同一条运行（created=false）；
   * 没带键而已有进行中的运行 → 409 RUN_IN_PROGRESS；上一次还在等确认 → 409 RUN_WAITING_CONFIRMATION（裁定 12）。暂停 / 停用时也能手动运行（指南 7.11「关着时只能手动运行」）。
   */
  async runNow(userId: string, id: string, idempotencyKey: string | undefined, audit: AuditFn): Promise<{ run: AssistantRun; created: boolean }> {
    await this.#mustGet(userId, id);
    if (idempotencyKey) {
      const prev = await this.d.store.findRunByKey(userId, id, idempotencyKey);
      if (prev) return { run: prev, created: false };
    }
    // 裁定 12：上一次还在等确认 → 不开新的一次（不会再多一张付费确认卡）
    if (await this.d.store.findWaitingRun(userId, id)) {
      await audit('assistant.run.request', { type: 'assistant', id }, 'failed', 'RUN_WAITING_CONFIRMATION');
      throw conflict('上一次运行还在等你确认，先在铃铛里同意或拒绝', 'RUN_WAITING_CONFIRMATION');
    }
    const run: AssistantRun = {
      id: randomUUID(),
      assistantId: id,
      userId,
      trigger: 'manual',
      scheduledFor: null,
      idempotencyKey: idempotencyKey ?? null,
      requestedAt: this.d.now(),
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      failureCode: null,
      summary: null,
      usageState: null,
      calls: 0,
      messageIds: [],
    };
    if ((await this.d.store.insertRun(userId, run)) === 'conflict') {
      if (idempotencyKey) {
        const prev = await this.d.store.findRunByKey(userId, id, idempotencyKey);
        if (prev) return { run: prev, created: false };
      }
      await audit('assistant.run.request', { type: 'assistant', id }, 'failed', 'RUN_IN_PROGRESS');
      throw conflict('这个助手正在运行，等这次结束再试', 'RUN_IN_PROGRESS');
    }
    await audit('assistant.run.request', { type: 'assistant_run', id: run.id }, 'ok', `assistant=${id} trigger=manual`);
    this.#launcher?.start(userId, run.id);
    return { run, created: true };
  }

  async cancelRun(userId: string, id: string, runId: string, audit: AuditFn): Promise<AssistantRun> {
    const r = await this.d.store.getRun(userId, id, runId);
    if (!r) throw notFound('找不到这次运行');
    if (!['queued', 'running', 'waiting_confirmation'].includes(r.status)) throw conflict('这次运行已经结束了', 'RUN_FINISHED');
    this.#launcher?.cancel(userId, runId);
    const done = await this.d.store.updateRun(userId, runId, ['queued', 'running', 'waiting_confirmation'], { status: 'cancelled', finishedAt: this.d.now() });
    await audit('assistant.run.cancel', { type: 'assistant_run', id: runId }, done ? 'ok' : 'failed');
    return done ?? ((await this.d.store.getRun(userId, id, runId)) as AssistantRun);
  }

  async runs(userId: string, id: string, limit: number, before?: Date) {
    await this.#mustGet(userId, id);
    const list = await this.d.store.listRuns(userId, id, limit, before);
    return { runs: list.map(runJson), nextBefore: list.length === limit ? list.at(-1)!.requestedAt.toISOString() : null };
  }

  async run(userId: string, id: string, runId: string) {
    const r = await this.d.store.getRun(userId, id, runId);
    if (!r) throw notFound('找不到这次运行');
    return { ...runJson(r), steps: foldSteps(await this.d.store.listSteps(userId, runId)) };
  }

  async messages(userId: string, id: string, limit: number, afterSeq?: number) {
    const a = await this.#mustGet(userId, id);
    return { messages: (await this.d.store.listMessages(userId, a.conversationId, limit, afterSeq)).map(messageJson) };
  }

  async markRead(userId: string, id: string): Promise<void> {
    const a = await this.#mustGet(userId, id);
    await this.d.store.markRead(userId, a.conversationId, this.d.now());
  }

  /**
   * 以助手的身份往会话里写一条（只给 Core 内部：执行器、建助手的开场白）。X-23 ①：
   * 助手 A 只能写自己的固定会话，拿着助手 B 的会话 id → 403；作者由 Core 决定，接口不接受调用方填的作者。
   */
  async postAsAssistant(
    userId: string,
    assistantId: string,
    conversationId: string,
    msg: { role: 'member' | 'system'; memberId: string | null; runId: string | null; content: string },
  ): Promise<ConversationMessage> {
    const a = await this.#mustGet(userId, assistantId);
    if (a.conversationId !== conversationId) throw new HttpError(403, 'FORBIDDEN', '助手只能写自己的会话');
    if (msg.role === 'member' && (!msg.memberId || !a.members.some((m) => m.memberId === msg.memberId))) {
      throw new HttpError(403, 'FORBIDDEN', '只有这个助手的成员能在它的会话里发言');
    }
    const m: ConversationMessage = { id: randomUUID(), conversationId, userId, ...msg, memberId: msg.role === 'member' ? msg.memberId : null, createdAt: this.d.now() };
    await this.d.store.appendMessage(userId, m);
    return m;
  }
}
