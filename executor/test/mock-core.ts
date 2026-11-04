/**
 * 模拟 Core（按 docs/executor-protocol.md 实现），用真 HTTP 服务器测试执行员。
 * Core 端真实接口就绪后，同一批测试改指向测试版 Core 即可做联调。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ResultRequest, Task, TakeoverRequest, TakeoverStatus } from '../src/protocol.js';

export const TEST_TOKEN = 'test-device-token-not-a-secret';

interface Takeover {
  id: string;
  taskId: string;
  req: TakeoverRequest;
  status: TakeoverStatus;
}

export class MockCore {
  server: Server | null = null;
  port = 0;
  queue: Task[] = [];
  claimed = new Map<string, Task>();
  results = new Map<string, ResultRequest>();
  progress: { taskId: string; body: Record<string, unknown> }[] = [];
  takeovers = new Map<string, Takeover>();
  secrets = new Map<string, string>();
  cancelTasks = new Set<string>();
  leaseLostTasks = new Set<string>();
  /** 所有请求的原始 body（检查有没有泄露凭据） */
  rawBodies: string[] = [];
  hellos = 0;
  secretCalls = 0;
  token = TEST_TOKEN;
  failNext = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  enqueue(t: Partial<Task> & Pick<Task, 'kind' | 'site'>): Task {
    const task: Task = { id: randomUUID(), createdAt: new Date().toISOString(), leaseExpiresAt: '', ...t };
    this.queue.push(task);
    return task;
  }

  resolveTakeover(taskId: string, status: TakeoverStatus = 'resolved'): void {
    for (const t of this.takeovers.values()) if (t.taskId === taskId && t.status === 'pending') t.status = status;
  }

  async waitFor(cond: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('waitFor 超时');
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) this.rawBodies.push(raw);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, data === undefined ? {} : { 'content-type': 'application/json' });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    const err = (status: number, code: string) => send(status, { error: { code, message: code } });

    if (this.failNext > 0) {
      this.failNext--;
      return err(503, 'UNAVAILABLE');
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) return err(401, 'UNAUTHORIZED');
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.replace(/^\/api\/executor/, '');
    let m: RegExpMatchArray | null;

    if (req.method === 'POST' && p === '/hello') {
      this.hellos++;
      return send(200, { executorId: 'exec-1', pollWaitSec: 1, leaseSec: 30, serverTime: new Date().toISOString() });
    }
    if (req.method === 'POST' && p === '/tasks/claim') {
      const end = Date.now() + Math.min(Number(body.waitSec ?? 1), 2) * 1000;
      while (this.queue.length === 0 && Date.now() < end && this.server) await new Promise((r) => setTimeout(r, 10));
      const t = this.queue.shift();
      if (!t) return send(204);
      t.leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
      this.claimed.set(t.id, t);
      return send(200, { task: t });
    }
    if ((m = p.match(/^\/tasks\/([^/]+)\/(progress|takeover|secret|result)$/)) && req.method === 'POST') {
      const [, id, op] = m as unknown as [string, string, string];
      const task = this.claimed.get(id);
      if (!task) return err(404, 'TASK_NOT_FOUND');
      if (this.leaseLostTasks.has(id)) return err(409, 'LEASE_LOST');
      if (op === 'progress') {
        this.progress.push({ taskId: id, body });
        return send(200, { leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), cancel: this.cancelTasks.has(id) });
      }
      if (op === 'takeover') {
        const tid = randomUUID();
        this.takeovers.set(tid, { id: tid, taskId: id, req: body as unknown as TakeoverRequest, status: 'pending' });
        return send(201, { takeoverId: tid });
      }
      if (op === 'secret') {
        this.secretCalls++;
        const declared = (task.secrets ?? []).some((s) => s.secretId === body.secretId && s.field === body.field);
        if (!declared) return err(422, 'SECRET_NOT_DECLARED');
        const v = this.secrets.get(`${String(body.secretId)}:${String(body.field)}`);
        return v === undefined ? err(404, 'SECRET_NOT_FOUND') : send(200, { value: v });
      }
      this.results.set(id, body as unknown as ResultRequest);
      return send(200, {});
    }
    if (req.method === 'GET' && (m = p.match(/^\/tasks\/([^/]+)\/takeover\/([^/]+)$/))) {
      const tid = m[2] as string;
      const end = Date.now() + Math.min(Number(url.searchParams.get('waitSec') ?? 1), 2) * 1000;
      while (this.takeovers.get(tid)?.status === 'pending' && Date.now() < end && this.server) await new Promise((r) => setTimeout(r, 10));
      const t = this.takeovers.get(tid);
      if (!t) return err(404, 'TAKEOVER_NOT_FOUND');
      return send(200, { status: t.status });
    }
    return err(404, 'NOT_FOUND');
  }
}
