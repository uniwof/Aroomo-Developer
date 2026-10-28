/**
 * 收件箱业务（Issue #7）：
 * - createInboxItem()：其他模块调用；同 related + kind 的 open 条目去重。
 * - 执行动作：同一条只能成功执行一次（按钮点过后整组禁用），并发重复只有一个成功，其余 409。
 * - 确认（D63）：普通动作点一下即执行（记 confirm.normal 审计）；重要动作（不可逆、花钱、涉及凭据）
 *   走统一确认服务：第一次 428 + challenge，两步确认拿到令牌后带令牌再调用才执行。
 * - 所有状态变化都写审计。
 */
import { randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { CONFIRM_KINDS, type ConfirmCtx, type ConfirmService } from '../confirm/confirm.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import {
  actionKind,
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
    const actions: InboxAction[] = [];
    const ids = new Set<string>();
    for (const raw of input.actions ?? []) {
      const label = raw.label.trim();
      if (!ACTION_ID_RE.test(raw.id) || !label || ids.has(raw.id)) throw badRequest('动作 id 必须唯一且只含 [a-z0-9_-]，label 不能为空', 'INVALID_ACTIONS');
      ids.add(raw.id);
      const kind = actionKind(raw);
      if (!CONFIRM_KINDS.includes(kind)) throw badRequest('未知的确认级别', 'INVALID_ACTIONS');
      if (kind === 'normal') {
        actions.push({ id: raw.id, label });
        continue;
      }
      let consequences = (raw.confirm?.consequences ?? []).map((c) => c.trim()).filter(Boolean);
      // 旧写法 irreversible: true 没有后果文字时给一条默认的
      if (consequences.length === 0 && !raw.confirm && raw.irreversible) consequences = ['这个操作不可撤销。'];
      if (consequences.length === 0) throw badRequest('重要确认的动作必须写明后果（confirm.consequences）', 'CONSEQUENCES_REQUIRED');
      actions.push({ id: raw.id, label, confirm: { kind, consequences } });
    }
    const item: InboxItem = {
      id: randomUUID(),
      group: input.group,
      kind,
      urgency,
      title,
      summary: input.summary?.trim() ?? '',
      ...(input.related ? { related: { ...input.related } } : {}),
      actions,
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
   * 执行动作。确认由统一确认服务处理（D63）：重要动作没有令牌时抛 428（带 challenge），
   * 操作员不能完成重要确认（403，D62）。
   */
  async act(id: string, actionId: string, ctx: ConfirmCtx, audit: AuditFn): Promise<InboxItem> {
    const target = { type: 'inbox', id };
    try {
      const item = await this.store.get(id);
      if (!item) throw notFound('找不到这条收件箱事项');
      const action = item.actions.find((a) => a.id === actionId);
      if (!action) throw badRequest('这条事项没有这个动作', 'UNKNOWN_ACTION');
      if (item.status !== 'open') throw conflict('这条事项已经处理过了', 'ALREADY_RESOLVED', { status: item.status });

      const kind = actionKind(action);
      await this.confirm.require(
        {
          scope: `inbox:${id}:${actionId}`,
          kind,
          title: `${item.title}：${action.label}`,
          consequences: action.confirm?.consequences ?? (action.irreversible ? ['这个操作不可撤销。'] : []),
          confirmLabel: action.label,
        },
        ctx,
        audit,
      );

      const done = await this.store.resolveIfOpen(id, { status: 'done', resolvedAt: this.now(), resolvedAction: actionId });
      if (!done) throw conflict('这条事项已经处理过了', 'ALREADY_RESOLVED');
      await audit('inbox.action.execute', target, 'ok', `${actionId}${kind !== 'normal' ? ` (${kind}, confirmed)` : ''}`);
      return done;
    } catch (err) {
      // 428 是「请确认」，不是失败；确认服务已经记了 confirm.requested
      if (err instanceof HttpError && err.code !== 'CONFIRM_REQUIRED') {
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
