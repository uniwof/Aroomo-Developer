/**
 * CoreTransport：执行员与 Core 之间的唯一出口（可替换：HTTP 长轮询 / 以后的 WebSocket 或 MCP）。
 * 只发出站请求；令牌放在请求头，从不出现在日志和错误消息里。
 */

import type {
  HelloRequest,
  HelloResponse,
  ProgressRequest,
  ProgressResponse,
  ResultRequest,
  Task,
  TakeoverRequest,
  TakeoverState,
} from './protocol.js';

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }

  /** 网络断、超时、5xx、429：可以退避重试 */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  get authFailed(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface CoreTransport {
  hello(req: HelloRequest): Promise<HelloResponse>;
  /** 长轮询；没任务返回 null */
  claim(waitSec: number, signal?: AbortSignal): Promise<Task | null>;
  progress(taskId: string, req: ProgressRequest): Promise<ProgressResponse>;
  takeover(taskId: string, req: TakeoverRequest): Promise<{ takeoverId: string }>;
  takeoverState(taskId: string, takeoverId: string, waitSec: number, signal?: AbortSignal): Promise<TakeoverState>;
  secret(taskId: string, secretId: string, field: string): Promise<string>;
  result(taskId: string, req: ResultRequest): Promise<void>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  /** 取令牌的函数：令牌不作为字段长期挂在对象上，方便以后接 Windows 凭据管理器 */
  getToken: () => string;
  version: string;
  fetchImpl?: typeof fetch;
  /** 普通请求超时；长轮询在此基础上加 waitSec */
  timeoutMs?: number;
  /** 本次进程的执行员 id（hello 后设置） */
  executorId?: string;
}

export class HttpTransport implements CoreTransport {
  readonly #o: HttpTransportOptions;
  readonly #fetch: typeof fetch;
  #executorId: string | undefined;

  constructor(o: HttpTransportOptions) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      throw new Error('Core 地址必须是 https（本机测试除外）');
    }
    this.#o = { ...o, baseUrl: o.baseUrl.replace(/\/+$/, '') };
    this.#fetch = o.fetchImpl ?? fetch;
    this.#executorId = o.executorId;
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraMs = 0, signal?: AbortSignal): Promise<{ status: number; data: T | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (this.#o.timeoutMs ?? 15_000) + extraMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#o.getToken()}`,
      'user-agent': `aroomo-executor/${this.#o.version}`,
      accept: 'application/json',
    };
    if (this.#executorId) headers['x-aroomo-executor'] = this.#executorId;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(`${this.#o.baseUrl}/api/executor${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'error',
      });
    } catch (e) {
      throw new CoreError(0, signal?.aborted ? 'ABORTED' : 'NETWORK', `连不上 Core：${(e as Error).name}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (res.status === 204) return { status: 204, data: null };
    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new CoreError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Core 返回 ${res.status}`);
    }
    return { status: res.status, data: data as T };
  }

  async hello(req: HelloRequest): Promise<HelloResponse> {
    const r = await this.#call<HelloResponse>('POST', '/hello', req);
    if (!r.data?.executorId) throw new CoreError(502, 'BAD_RESPONSE', 'hello 响应缺 executorId');
    this.#executorId = r.data.executorId;
    return r.data;
  }

  async claim(waitSec: number, signal?: AbortSignal): Promise<Task | null> {
    const r = await this.#call<{ task: Task }>('POST', '/tasks/claim', { waitSec }, waitSec * 1000, signal);
    return r.status === 204 ? null : (r.data?.task ?? null);
  }

  async progress(taskId: string, req: ProgressRequest): Promise<ProgressResponse> {
    const r = await this.#call<ProgressResponse>('POST', `/tasks/${encodeURIComponent(taskId)}/progress`, req);
    return r.data ?? { leaseExpiresAt: '', cancel: false };
  }

  async takeover(taskId: string, req: TakeoverRequest): Promise<{ takeoverId: string }> {
    const r = await this.#call<{ takeoverId: string }>('POST', `/tasks/${encodeURIComponent(taskId)}/takeover`, req);
    if (!r.data?.takeoverId) throw new CoreError(502, 'BAD_RESPONSE', 'takeover 响应缺 takeoverId');
    return r.data;
  }

  async takeoverState(taskId: string, takeoverId: string, waitSec: number, signal?: AbortSignal): Promise<TakeoverState> {
    const r = await this.#call<TakeoverState>(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}/takeover/${encodeURIComponent(takeoverId)}?waitSec=${waitSec}`,
      undefined,
      waitSec * 1000,
      signal,
    );
    return r.data ?? { status: 'pending' };
  }

  async secret(taskId: string, secretId: string, field: string): Promise<string> {
    const r = await this.#call<{ value: string }>('POST', `/tasks/${encodeURIComponent(taskId)}/secret`, { secretId, field });
    if (typeof r.data?.value !== 'string') throw new CoreError(502, 'BAD_RESPONSE', '保险箱响应格式不对');
    return r.data.value;
  }

  async result(taskId: string, req: ResultRequest): Promise<void> {
    await this.#call('POST', `/tasks/${encodeURIComponent(taskId)}/result`, req);
  }
}
