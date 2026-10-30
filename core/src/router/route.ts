/**
 * Core 路由（P0，DECISIONS D31）：
 * - 有 @ → 点名：被点名成员各自独立、并行回答；负责人不介入。
 * - 没有 @ → 交给负责人：P0 只用 single（单人完成）；敏感任务也只用单人完成。
 * - 被点名成员故障 / 超时 → 不自动换人，返回一行提示 +「交给负责人」按钮；用户点按钮后由 delegateFromHint 生成交给负责人的计划。
 * - 敏感项目（D38）：不把内容发给外部智能体成员——点名外部成员给提示，外部负责人不能接手。
 *
 * 真正调用模型由 executeMentionPlan 的 call 回调完成（后续经 LiteLLM），这里不做任何网络请求。
 */
import { parseMentions } from './mentions.js';
import type { DelegatePlan, Hint, RoutableMember, RouteContext, RoutePlan } from './types.js';

const DELEGATE_ACTION = { id: 'delegate_to_lead', label: '交给负责人' } as const;

export function delegateHint(text: string, memberId?: string, body?: string): Hint {
  return {
    kind: 'hint',
    text,
    ...(memberId !== undefined ? { memberId } : {}),
    actions: [DELEGATE_ACTION],
    ...(body !== undefined ? { body } : {}),
  };
}

function delegatePlan(body: string, ctx: Pick<RouteContext, 'members' | 'leadId' | 'sensitive'>): DelegatePlan {
  const lead = ctx.leadId ? ctx.members.find((m) => m.id === ctx.leadId) : undefined;
  if (ctx.sensitive && lead?.external) {
    return {
      mode: 'delegate',
      leadId: null,
      strategy: 'single',
      body,
      hints: [{ kind: 'hint', text: '敏感项目不能交给外部智能体负责人，请先指定一位内置负责人', actions: [] }],
    };
  }
  return { mode: 'delegate', leadId: ctx.leadId, strategy: 'single', body, hints: [] };
}

export function route(text: string, ctx: RouteContext): RoutePlan {
  const parsed = parseMentions(text, ctx.members);

  if (!parsed.hasMention) return delegatePlan(parsed.body, ctx);

  const byId = new Map<string, RoutableMember>(ctx.members.map((m) => [m.id, m]));
  const targets: string[] = [];
  const hints: Hint[] = [];

  for (const id of parsed.memberIds) {
    const m = byId.get(id);
    if (!m || !m.enabled) hints.push(delegateHint(`${m?.name ?? id} 已停用，暂时不能回答`, id, parsed.body));
    else if (ctx.sensitive && m.external) hints.push(delegateHint(`敏感项目不发给外部成员 ${m.name}`, id, parsed.body));
    else targets.push(id);
  }
  for (const name of parsed.unknown) {
    hints.push(delegateHint(`没有叫「${name}」的成员`, undefined, parsed.body));
  }

  return { mode: 'mention', targets, body: parsed.body, hints };
}

/**
 * 用户点了提示上的「交给负责人」：生成交给负责人的计划，原问题正文原样保留。
 * 不会自动换成另一个被点名的成员（D31）。
 */
export function delegateFromHint(hint: Hint, ctx: Pick<RouteContext, 'members' | 'leadId' | 'sensitive'>): DelegatePlan {
  if (!hint.actions.some((a) => a.id === 'delegate_to_lead')) throw new Error('这条提示没有「交给负责人」动作');
  if (hint.body === undefined) throw new Error('提示里缺少原问题正文，无法交给负责人');
  return delegatePlan(hint.body, ctx);
}

export type MemberCall = (memberId: string, body: string, signal: AbortSignal) => Promise<string>;

export type FailureReason = 'error' | 'timeout' | 'aborted';

export type MentionAnswer =
  | { memberId: string; status: 'ok'; text: string }
  | { memberId: string; status: 'failed'; reason: FailureReason; hint: Hint };

export const DEFAULT_MEMBER_TIMEOUT_MS = 120_000;

export interface ExecuteOptions {
  /** 每个成员的超时（默认 120 秒）；超时视同故障 */
  timeoutMs?: number;
  /** 外部取消（例如用户点了停止）：所有未完成的调用一起中止 */
  signal?: AbortSignal;
  /** 把失败提示写成「X 暂时无法回答」 */
  nameOf?: (id: string) => string;
}

/**
 * 执行点名计划：每个目标独立并行，任何一个失败 / 超时都不影响其他人，也不自动换人。
 * 每个调用拿到自己的 AbortSignal：超时或外部取消时被中止。
 */
export async function executeMentionPlan(
  targets: string[],
  body: string,
  call: MemberCall,
  nameOfOrOptions: ((id: string) => string) | ExecuteOptions = {},
): Promise<MentionAnswer[]> {
  const opts: ExecuteOptions = typeof nameOfOrOptions === 'function' ? { nameOf: nameOfOrOptions } : nameOfOrOptions;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBER_TIMEOUT_MS;
  const nameOf = opts.nameOf ?? ((id: string) => id);

  const one = (memberId: string): Promise<MentionAnswer> => {
    const ctrl = new AbortController();
    const fail = (reason: FailureReason): MentionAnswer => ({
      memberId,
      status: 'failed',
      reason,
      hint: delegateHint(`${nameOf(memberId)} 暂时无法回答`, memberId, body),
    });
    return new Promise<MentionAnswer>((resolve) => {
      let settled = false;
      const finish = (a: MentionAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(a);
      };
      const timer = setTimeout(() => {
        ctrl.abort(new Error('timeout'));
        finish(fail('timeout'));
      }, timeoutMs);
      const onAbort = () => {
        ctrl.abort(new Error('aborted'));
        finish(fail('aborted'));
      };
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      let p: Promise<string>;
      try {
        p = call(memberId, body, ctrl.signal);
      } catch {
        finish(fail('error'));
        return;
      }
      p.then(
        (text) => finish({ memberId, status: 'ok', text }),
        () => finish(fail('error')),
      );
    });
  };

  return Promise.all(targets.map(one));
}
