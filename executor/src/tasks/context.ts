/**
 * 任务上下文：处理器通过它报进度、取凭据、推接管卡、校验白名单。
 * 处理器拿不到 transport 和令牌，只能做这几件事。
 */

import type { Allowlist } from '../allowlist.js';
import type { BrowserSession, FillField } from '../ports/browser.js';
import type { ScreenshotSummary, SecretRef, Task, TakeoverReason } from '../protocol.js';

/** 任务被取消（所有者在接管卡上点了取消，或 Core 下发 cancel） */
export class TaskCancelled extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelled';
  }
}

/** 任务失败（带一个给所有者看的错误码） */
export class TaskFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskFailed';
  }
}

export interface TaskContext {
  readonly task: Task;
  readonly allowlist: Allowlist;
  progress(stage: string, message: string, screenshot?: ScreenshotSummary): Promise<void>;
  /** 从 Core 保险箱取值（只在内存；自动登记进脱敏器）。只能取任务声明过的 secret */
  secret(ref: SecretRef): Promise<string>;
  /** 推接管卡并等待；resolved 正常返回，cancelled 抛 TaskCancelled */
  takeover(reason: TakeoverReason, message: string, screenshot?: ScreenshotSummary): Promise<void>;
  /** 收到取消信号时抛 TaskCancelled */
  throwIfCancelled(): void;
}

export interface TaskOutcome {
  summary: string;
  screenshot?: ScreenshotSummary;
}

export type TaskHandler = (ctx: TaskContext, session: BrowserSession) => Promise<TaskOutcome>;

/** 导航到 url 前后都校验白名单；跳出白名单 → 推 not_allowed 接管卡后失败 */
export async function safeGoto(ctx: TaskContext, session: BrowserSession, url: string): Promise<void> {
  const before = ctx.allowlist.checkUrl(url);
  if (!before.ok) {
    await ctx.takeover('not_allowed', `目标网站不在本机白名单：${before.reason}。请在执行员配置里加上它再重派任务。`).catch(() => undefined);
    throw new TaskFailed('NOT_ALLOWED', before.reason);
  }
  await session.goto(url);
  await assertStillAllowed(ctx, session);
}

export async function assertStillAllowed(ctx: TaskContext, session: BrowserSession): Promise<void> {
  const now = await session.currentUrl();
  const d = ctx.allowlist.checkUrl(now);
  if (!d.ok) {
    await ctx.takeover('not_allowed', `页面跳到了白名单外：${d.reason}。已停止操作。`).catch(() => undefined);
    throw new TaskFailed('NOT_ALLOWED', d.reason);
  }
}

/** 有验证码 / 两步验证 / 付款就推接管卡等所有者处理，处理完再查；最多 maxRounds 轮 */
export async function handleBlockers(ctx: TaskContext, session: BrowserSession, maxRounds = 3): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    ctx.throwIfCancelled();
    const b = await session.detectBlocker();
    if (!b) return;
    const shot = await session.screenshot();
    await ctx.progress('waiting_owner', `需要你处理：${b.message}`, shot);
    await ctx.takeover(b.reason, b.message, shot);
    await assertStillAllowed(ctx, session);
  }
  if (await session.detectBlocker()) throw new TaskFailed('BLOCKED', '页面障碍处理多次仍未通过');
}

/** 按任务声明的 secrets 组装填写字段（值只在内存） */
export async function secretFields(ctx: TaskContext, fieldsWanted: string[]): Promise<FillField[]> {
  const out: FillField[] = [];
  for (const ref of ctx.task.secrets ?? []) {
    if (fieldsWanted.length && !fieldsWanted.includes(ref.field)) continue;
    const value = await ctx.secret(ref);
    out.push({ target: ref.field, value, sensitive: true });
  }
  return out;
}
