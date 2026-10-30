/** 断线重连退避：1s、2s、4s … 上限 maxMs，加 0–30% 抖动（合同第 4 节） */
export class Backoff {
  #attempt = 0;
  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 60_000,
    private readonly rand: () => number = Math.random,
  ) {}

  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 30);
    return Math.round(raw * (1 + 0.3 * this.rand()));
  }

  reset(): void {
    this.#attempt = 0;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
