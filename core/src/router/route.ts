/**
 * 最小 Core 路由（P0 范围，DECISIONS D31）：
 * - 有 @ → 点名：被点名成员各自独立、并行回答；负责人不介入。
 * - 没有 @ → 交给负责人：P0 只用 single（单人完成）。
 * - 被点名成员故障 → 不自动换人，返回一行提示 +「交给负责人」按钮。
 *
 * 真正调用模型由 executePlan 的 call 回调完成（后续经 LiteLLM），这里不做任何网络请求。
 */
import { parseMentions } from './mentions.js';
import type { Hint, RouteContext, RoutePlan } from './types.js';

export function delegateHint(text: string, memberId?: string): Hint {
  return {
    kind: 'hint',
    text,
    ...(memberId !== undefined ? { memberId } : {}),
    actions: [{ id: 'delegate_to_lead', label: '交给负责人' }],
  };
}

export function route(text: string, ctx: RouteContext): RoutePlan {
  const parsed = parseMentions(text, ctx.members);

  if (!parsed.hasMention) {
    return { mode: 'delegate', leadId: ctx.leadId, strategy: 'single', body: parsed.body, hints: [] };
  }

  const byId = new Map(ctx.members.map((m) => [m.id, m]));
  const targets: string[] = [];
  const hints: Hint[] = [];

  for (const id of parsed.memberIds) {
    const m = byId.get(id);
    if (m && m.enabled) targets.push(id);
    else hints.push(delegateHint(`${m?.name ?? id} 已停用，暂时不能回答`, id));
  }
  for (const name of parsed.unknown) {
    hints.push(delegateHint(`没有叫「${name}」的成员`));
  }

  return { mode: 'mention', targets, body: parsed.body, hints };
}

export type MemberCall = (memberId: string, body: string) => Promise<string>;

export type MentionAnswer =
  | { memberId: string; status: 'ok'; text: string }
  | { memberId: string; status: 'failed'; hint: Hint };

/**
 * 执行点名计划：每个目标独立并行，任何一个失败都不影响其他人，也不自动换人。
 * nameOf 用于把失败提示写成「X 暂时无法回答」。
 */
export async function executeMentionPlan(
  targets: string[],
  body: string,
  call: MemberCall,
  nameOf: (id: string) => string = (id) => id,
): Promise<MentionAnswer[]> {
  const settled = await Promise.allSettled(targets.map((id) => call(id, body)));
  return settled.map((r, idx) => {
    const memberId = targets[idx] as string;
    if (r.status === 'fulfilled') return { memberId, status: 'ok', text: r.value };
    return {
      memberId,
      status: 'failed',
      hint: delegateHint(`${nameOf(memberId)} 暂时无法回答`, memberId),
    };
  });
}
