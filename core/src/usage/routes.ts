import type { FastifyInstance } from 'fastify';
import { guard, scopeOf } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import type { MemberStore } from '../members/types.js';
import type { UsageService } from './service.js';

/**
 * GET /api/usage：额度圆环（每位在职成员今天调用几次 / 出错 / 被限流、你填的每天上限、圆环状态）
 * PUT /api/usage/limits/:memberId {dailyLimit: 整数 | null}：填/清某位成员每天的次数上限
 */
export function registerUsageRoutes(app: FastifyInstance, usage: UsageService, membersFor: (userId: string) => MemberStore): void {
  app.get('/api/usage', { ...guard('members:read', { user: true }) }, async (req) => {
    const scope = scopeOf(req);
    return usage.report(await membersFor(scope).listAll(), scope === 'owner');
  });

  app.put<{ Params: { memberId: string }; Body: { dailyLimit: number | null } }>(
    '/api/usage/limits/:memberId',
    {
      ...guard('members:write', { user: true }),
      schema: {
        params: { type: 'object', required: ['memberId'], properties: { memberId: { type: 'string', maxLength: 120 } } },
        body: { type: 'object', required: ['dailyLimit'], additionalProperties: false, properties: { dailyLimit: { type: ['integer', 'null'] } } },
      },
    },
    async (req) => {
      const member = (await membersFor(scopeOf(req)).listAll()).find((m) => m.id === req.params.memberId && !m.deletedAt);
      if (!member) throw new HttpError(404, 'NOT_FOUND', '没有这位成员');
      return usage.setLimit(member, req.body.dailyLimit, req.audit);
    },
  );
}
