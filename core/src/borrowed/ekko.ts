/**
 * 借用 Ekko Studio 逻辑的唯一入口（BSL 1.1，仅自用阶段；所有者 2026-11-05 13:00）。
 * 业务代码只能 import 这个文件；直接 import third_party/** 会被 ESLint（no-restricted-imports）拦下。
 * 收费前剥离：把这里的每个函数换成自研实现，third_party/ekko 清空，调用方不用改（#229 预检有一行检查）。
 */
import { DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH, resolveGroupChatAgentHandoffPolicy, shouldRouteGroupChatAgentHandoff } from '../third_party/ekko/handoff-depth.js';
import { notificationPreview } from '../third_party/ekko/notification-preview.js';
import { assertWorkflowScheduleCron, nextWorkflowScheduleAt } from '../third_party/ekko/schedule.js';
import { stripToolCallMarkup } from '../third_party/ekko/tool-call-markup.js';

/** 5 段 cron（分 时 日 月 周）在某时区里、严格晚于 after 的下一次；一年内没有就抛错。 */
export function nextCronAt(cron: string, timezone: string, after: Date): Date {
  return new Date(nextWorkflowScheduleAt(cron, timezone, after.getTime()));
}

/** cron 不合法就抛错。 */
export function assertCron(cron: string): void {
  assertWorkflowScheduleCron(cron);
}

/** 成员之间转交的深度上限（默认 4）。 */
export const HANDOFF_DEPTH_CAP = DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH;

/** 第 depth 次转交（0 起）还允许吗。 */
export function handoffAllowed(depth: number, maxDepth: number = HANDOFF_DEPTH_CAP): boolean {
  return shouldRouteGroupChatAgentHandoff(depth, resolveGroupChatAgentHandoffPolicy({ maxDepth }));
}

/** 去掉模型漏出来的工具调用标记（<tool_call>、<function_calls> 等）；Markdown 代码块原样保留。 */
export function stripToolMarkup(text: string): string {
  return stripToolCallMarkup(text);
}

/** 通知用的短文字：去掉 Markdown 和控制字符，标题 ≤40 字、正文 ≤160 字（按字形计）。 */
export function notificationText(title: string, content: string): { title: string; body: string } {
  return notificationPreview({ title, content }, true);
}
