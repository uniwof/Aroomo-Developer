/**
 * Core 的定时任务（PRODUCT §8.4 回收站 30 天、D63 确认记录、D45 Key 以 LiteLLM 为准）。
 * 单实例、进程内：每个任务启动后延迟一会儿先跑一次，然后按固定间隔跑；同一任务不会重叠。
 * 出错只写审计（actor = system），不影响服务。
 */
import type { AuditFn } from '../audit/types.js';

export interface Job {
  name: string;
  intervalMs: number;
  /** 首次运行前的延迟（默认 30 秒：等数据库和 LiteLLM 就绪） */
  firstDelayMs?: number;
  run: (audit: AuditFn) => Promise<string | void>;
}

export class Scheduler {
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #running = new Set<string>();
  readonly #jobs = new Map<string, Job>();
  #stopped = false;

  constructor(private readonly audit: AuditFn) {}

  add(job: Job): void {
    this.#jobs.set(job.name, job);
  }

  names(): string[] {
    return [...this.#jobs.keys()];
  }

  /** 立即跑一次（测试、手动触发用）。返回任务的说明；任务正在跑时返回 null。 */
  async runOnce(name: string): Promise<string | null> {
    const job = this.#jobs.get(name);
    if (!job) throw new Error(`没有这个任务：${name}`);
    if (this.#running.has(name)) return null;
    this.#running.add(name);
    try {
      const note = (await job.run(this.audit)) ?? '';
      await this.audit('job.run', { type: 'job', id: name }, 'ok', note || undefined);
      return note;
    } catch (err) {
      await this.audit('job.run', { type: 'job', id: name }, 'failed', (err as Error).name).catch(() => undefined);
      return null;
    } finally {
      this.#running.delete(name);
    }
  }

  start(): void {
    for (const job of this.#jobs.values()) {
      const first = setTimeout(() => {
        void this.runOnce(job.name);
        const every = setInterval(() => void this.runOnce(job.name), job.intervalMs);
        every.unref();
        this.#timers.add(every);
      }, job.firstDelayMs ?? 30_000);
      first.unref();
      this.#timers.add(first);
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  get stopped(): boolean {
    return this.#stopped;
  }
}
