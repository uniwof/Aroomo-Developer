/**
 * 最小 Core 路由（P0 范围，DECISIONS D31）：
 * - 有 @ → 点名：被点名成员各自独立、并行回答；负责人不介入。
 * - 没有 @ → 交给负责人：P0 只用 single（单人完成）。
 * - 被点名成员故障/超时 → 不自动换人，返回一行提示 +「交给负责人」按钮。
 *
 * 真正调用模型由 executePlan 的 call 回调完成（后续经 LiteLLM），这里不做任何网络请求。
 */
import { parseMentions } from './mentions.js';
import type { DelegatePlan, Hint, RouteContext, RoutePlan } from './types.js';

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

/**
 * 用户点击「交给负责人」后，生成交给负责人的 DelegatePlan（保留原问题正文）。
 */
export function delegateFromHint(body: string, ctx: RouteContext): DelegatePlan {
  return {
    mode: 'delegate',
    leadId: ctx.leadId,
    strategy: 'single',
    body,
    hints: [],
  };
}

export interface MemberCallOptions {
  signal?: AbortSignal;
}

export type MemberCall = (
  memberId: string,
  body: string,
  options?: MemberCallOptions,
) => Promise<string>;

export type MentionAnswer =
  | { memberId: string; status: 'ok'; text: string }
  | { memberId: string; status: 'failed'; hint: Hint };

export interface ExecuteMentionPlanOptions {
  /** 单个成员调用的超时毫秒数，默认 120,000 ms (120 秒) */
  timeoutMs?: number;
  /** 外部传入的取消 Signal */
  signal?: AbortSignal;
}

/**
 * 执行点名计划：每个目标独立并行，支持超时（默认 120 秒）与 AbortSignal。
 * 超时视同故障，返回「X 暂时无法回答」提示 +「交给负责人」动作；
 * 一个成员失败不影响其他成员。
 */
export async function executeMentionPlan(
  targets: string[],
  body: string,
  call: MemberCall,
  nameOf: (id: string) => string = (id) => id,
  options: ExecuteMentionPlanOptions = {},
): Promise<MentionAnswer[]> {
  const { timeoutMs = 120_000, signal: externalSignal } = options;

  const invokeTarget = async (memberId: string): Promise<string> => {
    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason);
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort(new Error('Timeout'));
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const callPromise = call(memberId, body, { signal: controller.signal });
      return await Promise.race([callPromise, timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  };

  const settled = await Promise.allSettled(targets.map((id) => invokeTarget(id)));

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
