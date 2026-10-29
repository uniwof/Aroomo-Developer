import { randomUUID } from "node:crypto";
import type { AuditFn } from "../audit/types.js";
import { badRequest, HttpError, notFound } from "../http/errors.js";
import {
  TASK_KINDS,
  type ExecutorRecord,
  type ExecutorStore,
  type TaskKind,
  type TaskRecord,
} from "./types.js";

export const LEASE_SEC = 600;
export const POLL_WAIT_SEC = 30;
const MAX_QUEUED_PER_USER = 200;

export const taskJson = (t: TaskRecord) => ({
  id: t.id,
  kind: t.kind,
  site: t.site,
  instruction: t.instruction,
  secrets: t.secrets,
  options: t.options,
  status: t.status,
  lastStage: t.lastStage,
  lastMessage: t.lastMessage,
  resultSummary: t.resultSummary,
  resultError: t.resultError,
  cancelRequested: t.cancelRequested,
  createdAt: t.createdAt.toISOString(),
  leaseExpiresAt: t.leaseExpiresAt ? t.leaseExpiresAt.toISOString() : null,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function validSite(site: string): boolean {
  if (/^android-app:\/\/[A-Za-z0-9._]+$/.test(site)) return true;
  try {
    const u = new URL(site);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export class ExecutorService {
  constructor(
    private readonly store: ExecutorStore,
    private readonly now: () => Date,
  ) {}

  async hello(
    userId: string,
    clientId: string,
    input: {
      deviceName: string;
      platform: string;
      version: string;
      adapters?: string[];
    },
    audit: AuditFn,
  ) {
    const at = this.now();
    const ex = await this.store.upsertExecutor({
      id: randomUUID(),
      userId,
      clientId,
      deviceName: clip(input.deviceName, 64) || "我的电脑",
      platform: clip(input.platform, 32),
      version: clip(input.version, 32),
      adapters: (input.adapters ?? []).slice(0, 10).map((a) => clip(a, 32)),
      createdAt: at,
      lastSeenAt: at,
    });
    await audit(
      "executor.hello",
      { type: "executor", id: ex.id },
      "ok",
      `${ex.platform} ${ex.version}`,
    );
    return {
      executorId: ex.id,
      pollWaitSec: POLL_WAIT_SEC,
      leaseSec: LEASE_SEC,
      serverTime: at.toISOString(),
    };
  }

  async #me(userId: string, clientId: string): Promise<ExecutorRecord> {
    const all = await this.store.listExecutors(userId);
    const ex = all.find((e) => e.clientId === clientId);
    if (!ex) throw new HttpError(409, "NO_HELLO", "请先发 hello 登记");
    await this.store.touchExecutor(userId, ex.id, this.now());
    return ex;
  }

  async claim(
    userId: string,
    clientId: string,
    waitSec: number,
    kinds: string[] | null,
    audit: AuditFn,
  ): Promise<TaskRecord | null> {
    const ex = await this.#me(userId, clientId);
    const deadline =
      Date.now() + Math.min(Math.max(waitSec, 0), POLL_WAIT_SEC) * 1000;
    for (;;) {
      const at = this.now();
      const t = await this.store.claim(
        userId,
        ex.id,
        kinds,
        at,
        new Date(at.getTime() + LEASE_SEC * 1000),
      );
      if (t) {
        await audit("executor.claim", { type: "task", id: t.id }, "ok", t.kind);
        return t;
      }
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  }

  async progress(
    userId: string,
    clientId: string,
    id: string,
    input: { stage: string; message: string },
  ) {
    const ex = await this.#me(userId, clientId);
    const at = this.now();
    const t = await this.store.renew(
      userId,
      id,
      ex.id,
      at,
      new Date(at.getTime() + LEASE_SEC * 1000),
      clip(input.stage, 64),
      clip(input.message, 500),
    );
    if (!t) await this.#lost(userId, id);
    return {
      leaseExpiresAt: (t as TaskRecord).leaseExpiresAt?.toISOString() ?? null,
      cancel: (t as TaskRecord).cancelRequested,
    };
  }

  async result(
    userId: string,
    clientId: string,
    id: string,
    input: {
      status: "succeeded" | "failed" | "cancelled";
      summary: string;
      error?: string;
    },
    audit: AuditFn,
  ) {
    const ex = await this.#me(userId, clientId);
    const t = await this.store.finish(
      userId,
      id,
      ex.id,
      input.status,
      clip(input.summary, 2000),
      input.error ? clip(input.error, 1000) : null,
      this.now(),
    );
    if (!t) {
      const cur = await this.store.getTask(userId, id);
      if (cur && cur.executorId === ex.id && cur.status === input.status)
        return; // 幂等
      await this.#lost(userId, id);
    }
    await audit("executor.result", { type: "task", id }, "ok", input.status);
  }

  async #lost(userId: string, id: string): Promise<never> {
    if (!(await this.store.getTask(userId, id)))
      throw new HttpError(404, "TASK_NOT_FOUND", "找不到这个任务");
    throw new HttpError(409, "LEASE_LOST", "租约已失效，请停止这个任务");
  }

  // —— 人用 ——
  async create(
    userId: string,
    input: {
      kind: string;
      site: string;
      instruction?: string;
      secrets?: { secretId: string; field: string }[];
      options?: Record<string, unknown>;
    },
    audit: AuditFn,
  ): Promise<TaskRecord> {
    if (!(TASK_KINDS as readonly string[]).includes(input.kind))
      throw badRequest("不认识的任务类型", "UNKNOWN_KIND");
    if (!validSite(input.site))
      throw badRequest(
        "网址不对：需要 https:// 开头的网址，或 android-app://包名",
        "BAD_SITE",
      );
    const queued = (await this.store.listTasks(userId, 500)).filter(
      (t) => t.status === "queued",
    ).length;
    if (queued >= MAX_QUEUED_PER_USER)
      throw new HttpError(409, "QUEUE_FULL", "排队的任务太多了");
    const at = this.now();
    const t: TaskRecord = {
      id: randomUUID(),
      userId,
      kind: input.kind as TaskKind,
      site: input.site,
      instruction: clip(input.instruction, 4000),
      secrets: (input.secrets ?? [])
        .slice(0, 10)
        .map((s) => ({ secretId: s.secretId, field: clip(s.field, 64) })),
      options: input.options ?? {},
      status: "queued",
      executorId: null,
      leaseExpiresAt: null,
      cancelRequested: false,
      lastStage: null,
      lastMessage: null,
      resultSummary: null,
      resultError: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.insertTask(t);
    await audit("task.create", { type: "task", id: t.id }, "ok", t.kind);
    return t;
  }
  list = (userId: string) => this.store.listTasks(userId, 100);
  async get(userId: string, id: string) {
    const t = await this.store.getTask(userId, id);
    if (!t) throw notFound("找不到这个任务");
    return t;
  }
  async cancel(userId: string, id: string, audit: AuditFn) {
    const t = await this.store.cancel(userId, id, this.now());
    if (!t) throw notFound("找不到这个任务");
    await audit("task.cancel", { type: "task", id }, "ok");
    return t;
  }
  /** 在线 = 最近 90 秒内有请求 */
  async executors(userId: string) {
    const nowMs = this.now().getTime();
    return (await this.store.listExecutors(userId)).map((e) => ({
      id: e.id,
      deviceName: e.deviceName,
      platform: e.platform,
      version: e.version,
      adapters: e.adapters,
      lastSeenAt: e.lastSeenAt.toISOString(),
      online: nowMs - e.lastSeenAt.getTime() < 90_000,
    }));
  }
}
