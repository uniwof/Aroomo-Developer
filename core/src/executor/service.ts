import { randomUUID } from "node:crypto";
import type { AuditFn } from "../audit/types.js";
import { badRequest, HttpError, notFound } from "../http/errors.js";
import type { SettingsStore } from "../settings/store.js";
import { MAX_ALLOWLIST, normalizeList, siteAllowed } from "./allowlist.js";
import {
  TASK_KINDS,
  type ExecutorRecord,
  type ExecutorStore,
  type TakeoverRecord,
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
    private readonly resolveSecret: (
      userId: string,
      secretId: string,
    ) => Promise<string | null> = async () => null,
    /** 某用户的设置视图（服务器端站点白名单存在这里） */
    private readonly settingsFor: (userId: string) => SettingsStore | null = () => null,
  ) {}

  async getAllowlist(userId: string): Promise<string[]> {
    const v = await this.settingsFor(userId)?.get<{ sites?: string[] }>("executor_allowlist");
    return Array.isArray(v?.sites) ? v.sites : [];
  }
  async setAllowlist(userId: string, sites: unknown[], audit: AuditFn): Promise<string[]> {
    if (sites.length > MAX_ALLOWLIST) throw badRequest("白名单最多 100 条", "TOO_MANY");
    const { list, bad } = normalizeList(sites);
    if (bad.length) throw badRequest(`这些条目不对：${bad.join("、")}`, "BAD_ENTRY");
    const st = this.settingsFor(userId);
    if (!st) throw new HttpError(500, "NO_SETTINGS", "设置不可用");
    await st.set("executor_allowlist", { sites: list }, this.now());
    await audit("executor.allowlist", { type: "executor", id: "allowlist" }, "ok", `${list.length} 条`);
    return list;
  }

  async hello(
    userId: string,
    clientId: string,
    input: {
      deviceName: string;
      platform: string;
      version: string;
      adapters?: string[];
      allowlistHash?: string;
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
      allowlistHash: input.allowlistHash ? clip(input.allowlistHash, 128) : null,
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

  /** 运行时取凭据：只能取本任务声明过的 secretId，只给持有租约的执行员；明文只在响应里，永不落库、不进审计 */
  async secret(
    userId: string,
    clientId: string,
    id: string,
    input: { secretId: string; field: string },
    audit: AuditFn,
  ): Promise<{ value: string }> {
    const ex = await this.#me(userId, clientId);
    const t = await this.store.getTask(userId, id);
    if (!t) throw new HttpError(404, "TASK_NOT_FOUND", "找不到这个任务");
    if (
      t.status !== "running" ||
      t.executorId !== ex.id ||
      !t.leaseExpiresAt ||
      t.leaseExpiresAt.getTime() <= this.now().getTime()
    )
      throw new HttpError(409, "LEASE_LOST", "租约已失效，请停止这个任务");
    if (!t.secrets.some((s) => s.secretId === input.secretId))
      throw new HttpError(422, "SECRET_NOT_DECLARED", "任务里没有声明这个凭据");
    const value = await this.resolveSecret(userId, input.secretId);
    if (value === null) {
      await audit("executor.secret", { type: "task", id }, "failed", "missing");
      throw new HttpError(404, "SECRET_NOT_FOUND", "保险箱里找不到这个凭据");
    }
    await audit(
      "executor.secret",
      { type: "task", id },
      "ok",
      clip(input.field, 64),
    );
    return { value };
  }

  #held(t: TaskRecord | null, exId: string): TaskRecord {
    if (!t) throw new HttpError(404, "TASK_NOT_FOUND", "找不到这个任务");
    if (
      t.status !== "running" ||
      t.executorId !== exId ||
      !t.leaseExpiresAt ||
      t.leaseExpiresAt.getTime() <= this.now().getTime()
    )
      throw new HttpError(409, "LEASE_LOST", "租约已失效，请停止这个任务");
    return t;
  }

  /** 推接管卡。租约在等待期间由 takeoverStatus 轮询续期（冻结）。 */
  async takeover(
    userId: string,
    clientId: string,
    id: string,
    input: { reason: string; message: string },
    audit: AuditFn,
  ): Promise<{ takeoverId: string }> {
    const ex = await this.#me(userId, clientId);
    this.#held(await this.store.getTask(userId, id), ex.id);
    const rec: TakeoverRecord = {
      id: randomUUID(),
      userId,
      taskId: id,
      reason: clip(input.reason, 200),
      message: clip(input.message, 1000),
      status: "pending",
      note: null,
      createdAt: this.now(),
      resolvedAt: null,
    };
    await this.store.insertTakeover(rec);
    await audit("executor.takeover", { type: "task", id }, "ok", rec.reason);
    return { takeoverId: rec.id };
  }

  async takeoverStatus(
    userId: string,
    clientId: string,
    id: string,
    tid: string,
    waitSec: number,
  ) {
    const ex = await this.#me(userId, clientId);
    const deadline =
      Date.now() + Math.min(Math.max(waitSec, 0), POLL_WAIT_SEC) * 1000;
    for (;;) {
      this.#held(await this.store.getTask(userId, id), ex.id);
      const t = await this.store.getTakeover(userId, id, tid);
      if (!t)
        throw new HttpError(404, "TAKEOVER_NOT_FOUND", "找不到这张接管卡");
      if (t.status !== "pending")
        return { status: t.status, ...(t.note ? { note: t.note } : {}) };
      const at = this.now();
      await this.store.renew(
        userId,
        id,
        ex.id,
        at,
        new Date(at.getTime() + LEASE_SEC * 1000),
        "takeover",
        "等待所有者处理",
      );
      if (Date.now() >= deadline) return { status: t.status };
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  }

  async takeovers(userId: string, id: string) {
    if (!(await this.store.getTask(userId, id)))
      throw new HttpError(404, "TASK_NOT_FOUND", "找不到这个任务");
    return (await this.store.listTakeovers(userId, id)).map((t) => ({
      id: t.id,
      reason: t.reason,
      message: t.message,
      status: t.status,
      note: t.note,
      createdAt: t.createdAt.toISOString(),
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
    }));
  }

  async resolveTakeover(
    userId: string,
    id: string,
    tid: string,
    input: { cancel?: boolean; note?: string },
    audit: AuditFn,
  ) {
    const t = await this.store.resolveTakeover(
      userId,
      id,
      tid,
      input.cancel ? "cancelled" : "resolved",
      input.note ? clip(input.note, 500) : null,
      this.now(),
    );
    if (!t) {
      if (await this.store.getTakeover(userId, id, tid))
        throw new HttpError(409, "TAKEOVER_DONE", "这张接管卡已经处理过了");
      throw new HttpError(404, "TAKEOVER_NOT_FOUND", "找不到这张接管卡");
    }
    await audit(
      "executor.takeover.resolve",
      { type: "task", id },
      "ok",
      t.status,
    );
    return { status: t.status };
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
    if (!siteAllowed(input.site, await this.getAllowlist(userId)))
      throw new HttpError(403, "SITE_NOT_ALLOWED", "这个网站不在你设置的白名单里");
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
      allowlistHash: e.allowlistHash,
      lastSeenAt: e.lastSeenAt.toISOString(),
      online: nowMs - e.lastSeenAt.getTime() < 90_000,
    }));
  }
}
