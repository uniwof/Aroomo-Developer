/**
 * 收件箱业务（Issue #7）：
 * - createInboxItem()：其他模块调用；同 related + kind 的 open 条目去重。
 * - 执行动作：同一条只能成功执行一次（按钮点过后整组禁用），并发重复只有一个成功，其余 409。
 * - irreversible 动作：第一次只返回 { needsConfirm, confirmToken }，带令牌的第二次才执行（D50）。
 * - 所有状态变化都写审计。
 */
import { randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import type { ConfirmService } from '../confirm/confirm.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import {
  INBOX_GROUPS,
  type InboxAction,
  type InboxGroup,
  type InboxItem,
  type InboxListFilter,
  type InboxRef,
  type InboxStore,
  URGENCIES,
  type Urgency,
} from './types.js';

export interface CreateInboxInput {
  group: InboxGroup;
  kind: string;
  urgency?: Urgency;
  title: string;
  summary?: string;
  related?: InboxRef;
  actions?: InboxAction[];
}

export type ActionOutcome =
  | { needsConfirm: true; confirmToken: string; expiresAt: Date }
  | { needsConfirm: false; item: InboxItem };

export interface BatchDismissResult {
  dismissed: string[];
  skipped: Array<{ id: string; reason: 'NOT_FOUND' | 'ALREADY_RESOLVED' }>;
}

const ACTION_ID_RE = /^[a-z0-9_-]{1,64}$/;

export class InboxService {
  constructor(
    private readonly store: InboxStore,
    private readonly confirm: ConfirmService,
    private readonly now: () => Date,
  ) {}

  /** 供其他模块调用。返回 created=false 表示命中去重、返回的是已有条目。 */
  async createInboxItem(input: CreateInboxInput, audit: AuditFn): Promise<{ item: InboxItem; created: boolean }> {
    if (!INBOX_GROUPS.includes(input.group)) throw badRequest('未知分组', 'INVALID_GROUP');
    const urgency = input.urgency ?? 'normal';
    if (!URGENCIES.includes(urgency)) throw badRequest('未知紧急度', 'INVALID_URGENCY');
    const title = input.title.trim();
    if (!title) throw badRequest('标题不能为空', 'INVALID_TITLE');
    const kind = input.kind.trim();
    if (!kind) throw badRequest('kind 不能为空', 'INVALID_KIND');
    const actions = (input.actions ?? []).map((a) => ({ ...a, label: a.label.trim() }));
    const ids = new Set<string>();
    for (const a of actions) {
      if (!ACTION_ID_RE.test(a.id) || !a.label || ids.has(a.id)) throw badRequest('动作 id 必须唯一且只含 [a-z0-9_-]，label 不能为空', 'INVALID_ACTIONS');
      ids.add(a.id);
    }
    const item: InboxItem = {
      id: randomUUID(),
      group: input.group,
      kind,
      urgency,
      title,
      summary: input.summary?.trim() ?? '',
      ...(input.related ? { related: { ...input.related } } : {}),
      actions: actions.map((a) => ({ id: a.id, label: a.label, ...(a.irreversible ? { irreversible: true } : {}) })),
      status: 'open',
      createdAt: this.now(),
    };
    const out = await this.store.insertDedup(item);
    await audit(out.created ? 'inbox.create' : 'inbox.create_deduped', { type: 'inbox', id: out.item.id }, 'ok', kind);
    return out;
  }

  list(filter: InboxListFilter = {}): Promise<InboxItem[]> {
    return this.store.list(filter);
  }

  async unreadCount(): Promise<{ total: number; byGroup: Record<InboxGroup, number> }> {
    const byGroup = await this.store.openCounts();
    return { total: Object.values(byGroup).reduce((a, b) => a + b, 0), byGroup };
  }

  /**
   * 执行动作。actorKey 用于把确认令牌绑定到操作者（例如 owner / operator:<id>）。
   * canConfirmIrreversible=false 时不可逆动作直接 403（操作员不能确认，PRODUCT §9.3）。
   */
  async act(
    id: string,
    actionId: string,
    opts: { confirmToken?: string; actorKey: string; canConfirmIrreversible: boolean },
    audit: AuditFn,
  ): Promise<ActionOutcome> {
    const target = { type: 'inbox', id };
    try {
      const item = await this.store.get(id);
      if (!item) throw notFound('找不到这条收件箱事项');
      const action = item.actions.find((a) => a.id === actionId);
      if (!action) throw badRequest('这条事项没有这个动作', 'UNKNOWN_ACTION');
      if (item.status !== 'open') throw conflict('这条事项已经处理过了', 'ALREADY_RESOLVED', { status: item.status });

      if (action.irreversible) {
        if (!opts.canConfirmIrreversible) throw new HttpError(403, 'FORBIDDEN', '不可逆操作只能由主人确认');
        const scope = `inbox:${id}:${actionId}`;
        if (!opts.confirmToken) {
          const t = await this.confirm.issue(scope, opts.actorKey);
          await audit('inbox.action.confirm_requested', target, 'ok', actionId);
          return { needsConfirm: true, ...t };
        }
        await this.confirm.consume(opts.confirmToken, scope, opts.actorKey);
      }

      const done = await this.store.resolveIfOpen(id, { status: 'done', resolvedAt: this.now(), resolvedAction: actionId });
      if (!done) throw conflict('这条事项已经处理过了', 'ALREADY_RESOLVED');
      await audit('inbox.action.execute', target, 'ok', `${actionId}${action.irreversible ? ' (irreversible, confirmed)' : ''}`);
      return { needsConfirm: false, item: done };
    } catch (err) {
      if (err instanceof HttpError) {
        await audit('inbox.action.execute', target, err.statusCode === 403 ? 'denied' : 'failed', `${actionId}: ${err.code}`);
      }
      throw err;
    }
  }

  async dismiss(id: string, audit: AuditFn): Promise<InboxItem> {
    const target = { type: 'inbox', id };
    const item = await this.store.get(id);
    if (!item) {
      await audit('inbox.dismiss', target, 'failed', 'NOT_FOUND');
      throw notFound('找不到这条收件箱事项');
    }
    const done = await this.store.resolveIfOpen(id, { status: 'dismissed', resolvedAt: this.now() });
    if (!done) {
      await audit('inbox.dismiss', target, 'failed', 'ALREADY_RESOLVED');
      throw conflict('这条事项已经处理过了', 'ALREADY_RESOLVED');
    }
    await audit('inbox.dismiss', target, 'ok');
    return done;
  }

  async dismissMany(ids: string[], audit: AuditFn): Promise<BatchDismissResult> {
    const out: BatchDismissResult = { dismissed: [], skipped: [] };
    for (const id of [...new Set(ids)]) {
      try {
        await this.dismiss(id, audit);
        out.dismissed.push(id);
      } catch (err) {
        if (err instanceof HttpError && (err.code === 'NOT_FOUND' || err.code === 'ALREADY_RESOLVED')) {
          out.skipped.push({ id, reason: err.code });
        } else throw err;
      }
    }
    return out;
  }

  /** 到期（例如候选过了有效期）：由其他模块 / 定时任务调用。 */
  async expire(id: string, audit: AuditFn): Promise<InboxItem | null> {
    const done = await this.store.resolveIfOpen(id, { status: 'expired', resolvedAt: this.now() });
    await audit('inbox.expire', { type: 'inbox', id }, done ? 'ok' : 'failed', done ? undefined : 'NOT_OPEN');
    return done;
  }
}
