/**
 * 执行员主循环：hello → 长轮询领取 → 执行 → 回报；断线自动重连。
 * 一次只跑一个任务（所有者电脑上，避免抢鼠标和浏览器）。
 */

import type { Allowlist } from './allowlist.js';
import { Backoff, sleep } from './backoff.js';
import type { Logger } from './logger.js';
import { pickBrowser, type BrowserPort, type BrowserSession } from './ports/browser.js';
import { TASK_KINDS, type ResultRequest, type ScreenshotSummary, type SecretRef, type Task, type TakeoverReason } from './protocol.js';
import { Redactor } from './redact.js';
import { TaskCancelled, TaskFailed, type TaskContext, type TaskHandler } from './tasks/context.js';
import { HANDLERS } from './tasks/handlers.js';
import { CoreError, type CoreTransport } from './transport.js';

export interface RunnerOptions {
  transport: CoreTransport;
  allowlist: Allowlist;
  browsers: BrowserPort[];
  logger: Logger;
  deviceName: string;
  platform: string;
  version: string;
  handlers?: Partial<Record<Task['kind'], TaskHandler>>;
  /** 测试可调小 */
  authRetryMs?: number;
  backoff?: Backoff;
  /** 接管卡最长等待（默认 24 小时；超时按取消处理） */
  takeoverMaxWaitMs?: number;
}

export type RunnerState = 'starting' | 'online' | 'reconnecting' | 'auth_failed' | 'stopped';

/** 租约丢失：任务已被 Core 收回，立刻停止且不提交结果 */
class LeaseLost extends Error {}

export class Runner {
  readonly #o: RunnerOptions;
  readonly #handlers: Record<Task['kind'], TaskHandler>;
  #state: RunnerState = 'starting';
  #pollWaitSec = 25;
  #leaseSec = 600;
  readonly #backoff: Backoff;
  /** 已处理任务数（测试与状态页用） */
  completed = 0;

  constructor(o: RunnerOptions) {
    this.#o = o;
    this.#handlers = { ...HANDLERS, ...(o.handlers ?? {}) };
    this.#backoff = o.backoff ?? new Backoff();
  }

  get state(): RunnerState {
    return this.#state;
  }

  async #hello(signal: AbortSignal): Promise<boolean> {
    const browsers: string[] = [];
    for (const b of this.#o.browsers) if (await b.available().catch(() => false)) browsers.push(b.name);
    try {
      const r = await this.#o.transport.hello({
        deviceName: this.#o.deviceName,
        platform: this.#o.platform,
        version: this.#o.version,
        adapters: browsers,
        allowlistHash: this.#o.allowlist.hash(),
      });
      this.#pollWaitSec = Math.max(1, Math.min(30, r.pollWaitSec || 25));
      this.#leaseSec = Math.max(30, r.leaseSec || 600);
      this.#state = 'online';
      this.#backoff.reset();
      this.#o.logger.info('已连上 Core', { executorId: r.executorId, adapters: browsers, sites: this.#o.allowlist.siteCount });
      return true;
    } catch (e) {
      await this.#onTransportError(e, signal);
      return false;
    }
  }

  async #onTransportError(e: unknown, signal: AbortSignal): Promise<void> {
    if (e instanceof CoreError && e.authFailed) {
      this.#state = 'auth_failed';
      this.#o.logger.error('设备令牌无效或权限不够，请在控制台重新生成执行员令牌', { status: e.status, code: e.code });
      await sleep(this.#o.authRetryMs ?? 5 * 60_000, signal);
      return;
    }
    this.#state = 'reconnecting';
    const ms = this.#backoff.next();
    this.#o.logger.warn('与 Core 的连接中断，稍后重连', { code: e instanceof CoreError ? e.code : 'UNKNOWN', retryInMs: ms });
    await sleep(ms, signal);
  }

  /** 运行直到 signal 中止 */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.#state !== 'online') {
        await this.#hello(signal);
        continue;
      }
      let task: Task | null;
      try {
        task = await this.#o.transport.claim(this.#pollWaitSec, signal);
      } catch (e) {
        if (signal.aborted) break;
        await this.#onTransportError(e, signal);
        if ((this.#state as RunnerState) === 'auth_failed') this.#state = 'starting';
        continue;
      }
      this.#backoff.reset();
      if (task) await this.runTask(task, signal);
    }
    this.#state = 'stopped';
  }

  async runTask(task: Task, signal: AbortSignal): Promise<void> {
    const redactor = new Redactor();
    const log = this.#o.logger.withRedactor(redactor);
    const t = this.#o.transport;
    let seq = 0;
    let cancelled = false;
    let leaseLost = false;
    let pausedForOwner = false;
    let session: BrowserSession | null = null;

    const guard = async <T>(p: Promise<T>): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof CoreError && e.code === 'LEASE_LOST') {
          leaseLost = true;
          throw new LeaseLost('租约已被收回');
        }
        throw e;
      }
    };

    const sendProgress = async (stage: string, message: string, screenshot?: ScreenshotSummary) => {
      const body = redactor.redactDeep({ seq: ++seq, stage, message, ...(screenshot ? { screenshot } : {}) });
      try {
        const r = await guard(t.progress(task.id, body));
        if (r.cancel) cancelled = true;
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        // 进度丢一条不影响任务；下一次心跳会再续租
        log.warn('进度发送失败', { taskId: task.id, code: e instanceof CoreError ? e.code : 'UNKNOWN' });
      }
    };

    const declared = (ref: SecretRef) => (task.secrets ?? []).some((s) => s.secretId === ref.secretId && s.field === ref.field);

    const ctx: TaskContext = {
      task,
      allowlist: this.#o.allowlist,
      progress: async (stage, message, screenshot) => {
        log.info('进度', { taskId: task.id, stage, message });
        await sendProgress(stage, message, screenshot);
        ctx.throwIfCancelled();
      },
      secret: async (ref) => {
        if (!declared(ref)) throw new TaskFailed('SECRET_NOT_DECLARED', '任务没有声明这个凭据');
        const v = await guard(t.secret(task.id, ref.secretId, ref.field));
        redactor.add(v);
        return v;
      },
      takeover: async (reason: TakeoverReason, message: string, screenshot?: ScreenshotSummary) => {
        const body = redactor.redactDeep({ reason, message, ...(screenshot ? { screenshot } : {}) });
        const { takeoverId } = await guard(t.takeover(task.id, body));
        log.info('已推接管卡，等你处理', { taskId: task.id, reason });
        pausedForOwner = true;
        const deadline = Date.now() + (this.#o.takeoverMaxWaitMs ?? 24 * 3600_000);
        const bo = new Backoff(1000, 30_000);
        try {
          while (Date.now() < deadline) {
            if (signal.aborted) throw new TaskCancelled('执行员正在退出');
            try {
              const st = await guard(t.takeoverState(task.id, takeoverId, this.#pollWaitSec, signal));
              bo.reset();
              if (st.status === 'resolved') return;
              if (st.status === 'cancelled') throw new TaskCancelled(st.note ? `你取消了任务：${st.note}` : '你取消了任务');
            } catch (e) {
              if (e instanceof TaskCancelled || e instanceof LeaseLost) throw e;
              if (e instanceof CoreError && !e.retryable) throw e;
              await sleep(bo.next(), signal);
            }
          }
          throw new TaskCancelled('接管卡等待超时');
        } finally {
          pausedForOwner = false;
        }
      },
      throwIfCancelled: () => {
        if (cancelled) throw new TaskCancelled();
        if (leaseLost) throw new LeaseLost('租约已被收回');
        if (signal.aborted) throw new TaskCancelled('执行员正在退出');
      },
    };

    // 心跳：每 leaseSec/3 续租一次；等所有者处理时 Core 冻结租约，不必发
    const hb = setInterval(
      () => {
        if (pausedForOwner || leaseLost) return;
        void sendProgress('heartbeat', '仍在执行').catch(() => undefined);
      },
      Math.max(1000, (this.#leaseSec * 1000) / 3),
    );

    let result: ResultRequest;
    try {
      log.info('领到任务', { taskId: task.id, kind: task.kind });
      if (!(TASK_KINDS as readonly string[]).includes(task.kind)) throw new TaskFailed('UNKNOWN_KIND', `不认识的任务类型 ${task.kind}`);
      const handler = this.#handlers[task.kind];
      const port = await pickBrowser(this.#o.browsers);
      if (!port) throw new TaskFailed('NO_BROWSER', '本机没有可用的浏览器适配器（ego lite / Playwright 都不可用）');
      session = await port.open();
      const out = await handler(ctx, session);
      result = { status: 'succeeded', summary: out.summary, ...(out.screenshot ? { screenshot: out.screenshot } : {}) };
    } catch (e) {
      if (e instanceof LeaseLost || leaseLost) {
        log.warn('任务租约已被收回，停止且不提交结果', { taskId: task.id });
        result = { status: 'failed', summary: '' };
      } else if (e instanceof TaskCancelled) {
        result = { status: 'cancelled', summary: e.message };
      } else if (e instanceof TaskFailed) {
        result = { status: 'failed', summary: e.message, error: { code: e.code, message: e.message } };
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        result = { status: 'failed', summary: '执行出错', error: { code: e instanceof CoreError ? e.code : 'INTERNAL', message: msg } };
      }
    } finally {
      clearInterval(hb);
      if (session) await session.close().catch(() => undefined);
    }

    if (!leaseLost) await this.#submit(task.id, redactor.redactDeep(result), log, signal);
    log.info('任务结束', { taskId: task.id, status: leaseLost ? 'lease_lost' : result.status });
    redactor.clear();
    this.completed++;
  }

  async #submit(taskId: string, result: ResultRequest, log: Logger, signal: AbortSignal): Promise<void> {
    const bo = new Backoff(1000, 30_000);
    for (let i = 0; i < 8; i++) {
      try {
        await this.#o.transport.result(taskId, result);
        return;
      } catch (e) {
        if (e instanceof CoreError && !e.retryable) {
          log.error('结果提交被 Core 拒绝', { taskId, code: e.code });
          return;
        }
        if (signal.aborted && i > 0) break;
        await sleep(bo.next(), signal.aborted ? undefined : signal);
      }
    }
    log.error('结果多次提交失败，Core 会在租约到期后退回任务', { taskId });
  }
}
