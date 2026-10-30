/**
 * 接管卡进收件箱（M4）：执行员遇到验证码 / 两步验证等需要人的地方，推一张「待你拍板」的紧急卡。
 * 卡上两个按钮：「我处理好了，继续」「取消这个任务」；在控制台任务页处理后，卡片自动收回。
 * 卡片不含任何凭据，只有站点、原因和执行员写的一句话。
 */
import type { AuditFn } from "../audit/types.js";
import { guard, scopeOf } from "../auth/plugin.js";
import type { FastifyInstance } from "fastify";
import type { InboxService } from "../inbox/service.js";
import type { Job } from "../jobs/scheduler.js";
import type { SettingsStore } from "../settings/store.js";
import { badRequest, HttpError } from "../http/errors.js";
import type { ExecutorService, TakeoverHooks } from "./service.js";

export const TAKEOVER_KIND = "executor.takeover";
const OWNER = "owner";

const REASON_TEXT: Record<string, string> = {
  captcha: "要过人机验证",
  "2fa": "要输入两步验证",
  payment: "走到了付款环节",
  login_failed: "登录没成功",
  not_allowed: "想去白名单以外的网站",
};

/**
 * 打扰预算（D100）：每天（北京时间）接管卡不超过 N 张（默认 3，可调）。
 * 超预算的接管卡降为普通级（不「紧急」、不即时提醒），只躺在收件箱里，30 分钟没人处理就自动取消任务；
 * 付款类（payment）每次都要人确认，永远是紧急卡，也不会被自动取消。
 */
export const DEFAULT_DAILY_BUDGET = 3;
export const QUIET_EXPIRE_MS = 30 * 60 * 1000;
const BUDGET_KEY = "interrupt_budget";
const DAY = 24 * 60 * 60 * 1000;
const CST = 8 * 60 * 60 * 1000;
const dayStart = (d: Date) => new Date(Math.floor((d.getTime() + CST) / DAY) * DAY - CST);

export class InterruptBudget {
  constructor(
    private readonly settings: (userId: string) => SettingsStore,
    private readonly now: () => Date,
  ) {}
  async daily(userId: string): Promise<number> {
    const v = await this.settings(userId).get<{ daily: number }>(BUDGET_KEY);
    return v && Number.isInteger(v.daily) && v.daily >= 0 ? v.daily : DEFAULT_DAILY_BUDGET;
  }
  async set(userId: string, daily: number, audit: AuditFn): Promise<{ daily: number }> {
    if (!Number.isInteger(daily) || daily < 0 || daily > 50) throw badRequest("每天的打扰次数填 0 到 50 的整数", "BAD_BUDGET");
    await this.settings(userId).set(BUDGET_KEY, { daily }, this.now());
    await audit("interrupt.budget", { type: "settings", id: BUDGET_KEY }, "ok", String(daily));
    return { daily };
  }
}

export function registerInterruptBudgetRoutes(app: FastifyInstance, budget: InterruptBudget): void {
  app.get("/api/interrupt-budget", { ...guard("members:read", { user: true }) }, async (req) => ({
    daily: await budget.daily(scopeOf(req)),
  }));
  app.put<{ Body: { daily: number } }>(
    "/api/interrupt-budget",
    {
      ...guard("members:write", { user: true }),
      schema: { body: { type: "object", required: ["daily"], additionalProperties: false, properties: { daily: { type: "integer" } } } },
    },
    async (req) => budget.set(scopeOf(req), req.body.daily, req.audit),
  );
}

/** 超预算的静默接管卡：超过 30 分钟没人处理就取消任务（只看所有者；加固阶段再按用户遍历） */
export function quietTakeoverExpiryJob(inbox: InboxService, svc: ExecutorService, now: () => Date): Job {
  return {
    name: "takeover-quiet-expiry",
    intervalMs: 5 * 60 * 1000,
    firstDelayMs: 60_000,
    async run(audit) {
      const open = await inbox.list({ group: "decision", status: "open" });
      let n = 0;
      for (const it of open) {
        if (it.kind !== TAKEOVER_KIND || it.urgency === "urgent") continue;
        if (now().getTime() - it.createdAt.getTime() < QUIET_EXPIRE_MS) continue;
        const [taskId, tid] = (it.related?.id ?? "").split("/");
        if (!taskId || !tid) continue;
        try {
          await svc.resolveTakeover(it.userId ?? OWNER, taskId, tid, { cancel: true, note: "超预算的接管 30 分钟没人处理，已自动取消" }, audit);
          n++;
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          // 已经被处理 / 任务没了：把卡收掉
          await inbox.expire(it.id, audit);
        }
      }
      return n ? `cancelled=${n}` : "";
    },
  };
}

/** 收件箱里「谁的」：所有者没有 userId（沿用 D117 约定） */
const inboxUser = (userId: string) => (userId === OWNER ? undefined : userId);
const refId = (taskId: string, tid: string) => `${taskId}/${tid}`;

function hostOf(site: string): string {
  try {
    return new URL(site).host || site;
  } catch {
    return site;
  }
}

export function takeoverHooks(inbox: InboxService, budget?: InterruptBudget, now: () => Date = () => new Date()): TakeoverHooks {
  return {
    async opened(userId, info, audit) {
      const why = REASON_TEXT[info.reason] ?? "需要你来一下";
      // 今天已经推过几张接管卡；达到预算后，非付款类降为静默卡
      let quiet = false;
      if (budget && info.reason !== "payment") {
        const since = dayStart(now()).getTime();
        const today = (await inbox.list({ group: "decision", ...(inboxUser(userId) ? { userId: inboxUser(userId)! } : {}) })).filter(
          (i) => i.kind === TAKEOVER_KIND && i.createdAt.getTime() >= since,
        ).length;
        quiet = today >= (await budget.daily(userId));
      }
      await inbox.createInboxItem(
        {
          group: "decision",
          kind: TAKEOVER_KIND,
          urgency: quiet ? "normal" : "urgent",
          title: `电脑上的任务${why}：${hostOf(info.site)}`,
          summary: quiet
            ? `${info.message || "执行员停在这里等你。"} 今天的打扰次数已经用完，所以没有提醒你。30 分钟内没处理，这个任务会自动取消；想继续就去电脑上处理好再点「我处理好了」。`
            : `${info.message || "执行员停在这里等你。"} 去电脑上处理好再点「我处理好了」；任务会一直等到你回来（租约冻结），不想继续就取消。`,
          related: { type: "takeover", id: refId(info.taskId, info.takeoverId) },
          actions: [
            { id: "done", label: "我处理好了，继续" },
            { id: "cancel", label: "取消这个任务" },
          ],
          ...(inboxUser(userId) ? { userId: inboxUser(userId) } : {}),
        },
        audit,
      );
    },
    async closed(userId, taskId, tid, audit) {
      await inbox.resolveRelated(
        TAKEOVER_KIND,
        { type: "takeover", id: refId(taskId, tid) },
        "done",
        audit,
        undefined,
        inboxUser(userId),
      );
    },
  };
}

/** 卡上的按钮 → 处理接管卡。已经被别处处理过（409）就当作成功，让卡片收掉。 */
export function registerTakeoverHandler(inbox: InboxService, svc: ExecutorService): void {
  inbox.registerHandler(TAKEOVER_KIND, async (item, actionId, audit) => {
    const [taskId, tid] = (item.related?.id ?? "").split("/");
    if (!taskId || !tid) return;
    try {
      await svc.resolveTakeover(item.userId ?? OWNER, taskId, tid, { cancel: actionId === "cancel" }, audit, true);
    } catch (e) {
      if (e instanceof HttpError && e.code === "TAKEOVER_DONE") return;
      throw e;
    }
  });
}
