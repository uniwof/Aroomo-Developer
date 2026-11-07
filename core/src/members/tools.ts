/**
 * 成员工具分配 v1（docs/api/design-member-tools-v1.md；Poke 清单第 9 项后半）。
 * 只存引用（成员 × 网关工具名 + 分配时间）；名字、说明、风险、可用与否每次当场从工具网关读，不在库里缓存。
 * 读：账号也能用，只按 scopeOf(req) 读本账号；改：只给所有者范围（家人账号 403，先判权限再校验）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditFn } from '../audit/types.js';
import { guard, scopeOf } from '../auth/plugin.js';
import type { Db } from '../db/db.js';
import { userScoped } from '../db/scope.js';
import { HttpError, badRequest, conflict, notFound } from '../http/errors.js';
import type { PublicTool } from '../gateway/service.js';
import type { MemberStore } from './types.js';

export const MAX_TOOLS_PER_MEMBER = 50;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface ToolAssignment {
  tool: string;
  assignedAt: Date;
}
export type AssignResult = { kind: 'added' | 'exists'; row: ToolAssignment } | { kind: 'too_many' };

export interface MemberToolStore {
  list(userId: string, memberId: string): Promise<ToolAssignment[]>;
  /** 按 (账号, 成员, 工具) 幂等：已有就原样返回；新加时同一成员已有 max 个回 too_many */
  assign(userId: string, memberId: string, tool: string, now: Date, max: number): Promise<AssignResult>;
  unassign(userId: string, memberId: string, tool: string): Promise<boolean>;
}

const byTime = (a: ToolAssignment, b: ToolAssignment) => a.assignedAt.getTime() - b.assignedAt.getTime() || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);

/** 内存版（开发 / 测试）。成员被彻底删除后读时丢掉它的分配（PG 版由外键 ON DELETE CASCADE 保证） */
export class MemoryMemberToolStore implements MemberToolStore {
  readonly #rows: (ToolAssignment & { userId: string; memberId: string })[] = [];
  constructor(private readonly members?: MemberStore) {}
  async #prune(userId: string, memberId: string) {
    if (!this.members || (await this.members.forUser(userId).get(memberId))) return;
    for (let i = this.#rows.length - 1; i >= 0; i--) if (this.#rows[i]!.userId === userId && this.#rows[i]!.memberId === memberId) this.#rows.splice(i, 1);
  }
  #of(userId: string, memberId: string) {
    return this.#rows.filter((r) => r.userId === userId && r.memberId === memberId);
  }
  async list(userId: string, memberId: string): Promise<ToolAssignment[]> {
    await this.#prune(userId, memberId);
    return this.#of(userId, memberId)
      .map(({ tool, assignedAt }) => ({ tool, assignedAt }))
      .sort(byTime);
  }
  async assign(userId: string, memberId: string, tool: string, now: Date, max: number): Promise<AssignResult> {
    await this.#prune(userId, memberId);
    const mine = this.#of(userId, memberId);
    const had = mine.find((r) => r.tool === tool);
    if (had) return { kind: 'exists', row: { tool, assignedAt: had.assignedAt } };
    if (mine.length >= max) return { kind: 'too_many' };
    this.#rows.push({ userId, memberId, tool, assignedAt: now });
    return { kind: 'added', row: { tool, assignedAt: now } };
  }
  async unassign(userId: string, memberId: string, tool: string): Promise<boolean> {
    const i = this.#rows.findIndex((r) => r.userId === userId && r.memberId === memberId && r.tool === tool);
    if (i < 0) return false;
    this.#rows.splice(i, 1);
    return true;
  }
}

interface Row {
  tool: string;
  assigned_at: Date | string;
}
const toRow = (r: Row): ToolAssignment => ({ tool: r.tool, assignedAt: new Date(r.assigned_at) });

/** PostgreSQL 版（迁移 0035，RLS 按 user_id；查询仍带 WHERE user_id 双保险） */
export class PgMemberToolStore implements MemberToolStore {
  constructor(private readonly db: Db) {}
  async list(userId: string, memberId: string): Promise<ToolAssignment[]> {
    const { rows } = await userScoped(this.db, userId).query<Row>(
      'SELECT tool, assigned_at FROM member_tools WHERE user_id = $1 AND member_id = $2 ORDER BY assigned_at, tool',
      [userId, memberId],
    );
    return rows.map(toRow);
  }
  async assign(userId: string, memberId: string, tool: string, now: Date, max: number): Promise<AssignResult> {
    return userScoped(this.db, userId).tx(async (q) => {
      // 同一成员的分配串行（数个数 + 插入不被并发穿透）
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`member_tools:${userId}:${memberId}`]);
      const { rows: had } = await q.query<Row>('SELECT tool, assigned_at FROM member_tools WHERE user_id = $1 AND member_id = $2 AND tool = $3', [userId, memberId, tool]);
      if (had[0]) return { kind: 'exists', row: toRow(had[0]) } as const;
      const { rows: c } = await q.query<{ n: string | number }>('SELECT count(*) AS n FROM member_tools WHERE user_id = $1 AND member_id = $2', [userId, memberId]);
      if (Number(c[0]?.n ?? 0) >= max) return { kind: 'too_many' } as const;
      const { rows } = await q.query<Row>('INSERT INTO member_tools (user_id, member_id, tool, assigned_at) VALUES ($1,$2,$3,$4) RETURNING tool, assigned_at', [userId, memberId, tool, now]);
      return { kind: 'added', row: toRow(rows[0]!) } as const;
    });
  }
  async unassign(userId: string, memberId: string, tool: string): Promise<boolean> {
    const { rows } = await userScoped(this.db, userId).query<{ tool: string }>(
      'DELETE FROM member_tools WHERE user_id = $1 AND member_id = $2 AND tool = $3 RETURNING tool',
      [userId, memberId, tool],
    );
    return rows.length > 0;
  }
}

export interface AssignedToolJson {
  tool: string;
  description: string | null;
  risk: PublicTool['risk'] | null;
  /** 此刻在不在这个账号的工具网关清单里（HTTP 工具停用 / 删除 → false） */
  available: boolean;
  assignedAt: string;
}

export class MemberToolService {
  constructor(
    private readonly store: MemberToolStore,
    private readonly members: MemberStore,
    private readonly gatewayTools: (userId: string) => Promise<PublicTool[]>,
    private readonly now: () => Date,
  ) {}

  async #member(scope: string, id: string, forWrite: boolean) {
    const m = await this.members.forUser(scope).get(id);
    if (!m || (forWrite && m.deletedAt)) throw notFound('找不到这位成员');
    return m;
  }
  #json(row: ToolAssignment, gw: PublicTool[]): AssignedToolJson {
    const t = gw.find((x) => x.name === row.tool);
    return { tool: row.tool, description: t?.description ?? null, risk: t?.risk ?? null, available: !!t, assignedAt: row.assignedAt.toISOString() };
  }

  async list(scope: string, memberId: string): Promise<AssignedToolJson[]> {
    await this.#member(scope, memberId, false);
    const [rows, gw] = await Promise.all([this.store.list(scope, memberId), this.gatewayTools(scope)]);
    return rows.map((r) => this.#json(r, gw));
  }

  async assign(scope: string, memberId: string, tool: string, audit: AuditFn): Promise<AssignedToolJson> {
    await this.#member(scope, memberId, true);
    const gw = await this.gatewayTools(scope);
    if (!gw.some((t) => t.name === tool)) throw badRequest('资源库里没有这个工具，或它已停用');
    const r = await this.store.assign(scope, memberId, tool, this.now(), MAX_TOOLS_PER_MEMBER);
    if (r.kind === 'too_many') throw conflict(`每位成员最多分配 ${MAX_TOOLS_PER_MEMBER} 个工具`, 'TOO_MANY');
    if (r.kind === 'added') await audit('member.tool.assign', { type: 'member', id: memberId }, 'ok', tool);
    return this.#json(r.row, gw);
  }

  async unassign(scope: string, memberId: string, tool: string, audit: AuditFn): Promise<void> {
    await this.#member(scope, memberId, false);
    if (!(await this.store.unassign(scope, memberId, tool))) throw notFound('这位成员没有分到这个工具');
    await audit('member.tool.unassign', { type: 'member', id: memberId }, 'ok', tool);
  }
}

const params = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, tool: { type: 'string', pattern: TOOL_NAME_RE.source } },
} as const;

/** 改分配只给所有者范围；放在 preValidation：家人账号先 403，不先校验参数（同 /work） */
function ownerOnlyWrite() {
  const g = guard('members:write', { user: true });
  return {
    config: g.config,
    preValidation: async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      await g.preHandler.call(this, req, reply);
      if (scopeOf(req) !== 'owner') {
        await req.audit('auth.denied', { type: 'route', id: req.routeOptions.url ?? '' }, 'denied', `${req.method} 成员工具分配第一版只给所有者`);
        throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
      }
    },
  };
}

export function registerMemberToolRoutes(app: FastifyInstance, svc: MemberToolService): void {
  app.get<{ Params: { id: string } }>('/api/members/:id/tools', { ...guard('members:read', { user: true }), schema: { params } }, async (req) => ({
    tools: await svc.list(scopeOf(req), req.params.id),
  }));
  const w = ownerOnlyWrite();
  app.put<{ Params: { id: string; tool: string } }>('/api/members/:id/tools/:tool', { ...w, schema: { params } }, async (req) => ({
    tool: await svc.assign(scopeOf(req), req.params.id, req.params.tool, req.audit),
  }));
  app.delete<{ Params: { id: string; tool: string } }>('/api/members/:id/tools/:tool', { ...w, schema: { params } }, async (req, reply) => {
    await svc.unassign(scopeOf(req), req.params.id, req.params.tool, req.audit);
    return reply.status(204).send();
  });
}
