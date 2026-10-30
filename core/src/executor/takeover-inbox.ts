/**
 * 接管卡进收件箱（M4）：执行员遇到验证码 / 两步验证等需要人的地方，推一张「待你拍板」的紧急卡。
 * 卡上两个按钮：「我处理好了，继续」「取消这个任务」；在控制台任务页处理后，卡片自动收回。
 * 卡片不含任何凭据，只有站点、原因和执行员写的一句话。
 */
import type { InboxService } from "../inbox/service.js";
import { HttpError } from "../http/errors.js";
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

export function takeoverHooks(inbox: InboxService): TakeoverHooks {
  return {
    async opened(userId, info, audit) {
      const why = REASON_TEXT[info.reason] ?? "需要你来一下";
      await inbox.createInboxItem(
        {
          group: "decision",
          kind: TAKEOVER_KIND,
          urgency: "urgent",
          title: `电脑上的任务${why}：${hostOf(info.site)}`,
          summary: `${info.message || "执行员停在这里等你。"} 去电脑上处理好再点「我处理好了」；任务会一直等到你回来（租约冻结），不想继续就取消。`,
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
