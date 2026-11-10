/** 确认卡的服务端接口（DECISIONS D63；约定见 docs/architecture/CONFIRM-CARD.md）。主人和家人账号能用，但每个人只能看 / 点自己名下的确认卡（按 actor 绑定，别人的卡 404）；操作员、客户端令牌不行。 */
import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import { actorKey, type Principal, principalCan } from '../auth/tokens.js';
import { PASSWORD_MAX } from '../users/password.js';
import type { ConfirmService } from './confirm.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } } } as const;

/** #346 M2：账号会话、且本身没有重要确认权限（家人）→ 本人确认，第二步要密码 */
const accountSelf = (p: Principal): boolean => p.type === 'user' && !principalCan(p, 'confirm:important');

export function registerConfirmRoutes(app: FastifyInstance, svc: ConfirmService): void {
  app.get<{ Params: { id: string } }>(
    '/api/confirm/:id',
    { ...guard('confirm:important', { user: true }), schema: { params: idParam } },
    async (req) => ({ confirm: await svc.get(req.params.id, actorKey(req.principal!), accountSelf(req.principal!)) }),
  );

  app.post<{ Params: { id: string }; Body: { step: 1 | 2; password?: string } }>(
    '/api/confirm/:id/steps',
    {
      ...guard('confirm:important', { user: true }),
      schema: {
        params: idParam,
        body: { type: 'object', required: ['step'], additionalProperties: false, properties: { step: { type: 'integer', enum: [1, 2] }, password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX } } },
      },
    },
    async (req) => {
      const h = req.headers['cf-access-jwt-assertion'];
      const accessJwt = typeof h === 'string' && h.length > 0 ? h : undefined;
      const self = accountSelf(req.principal!);
      const out = await svc.step(
        req.params.id,
        req.body.step,
        { actor: actorKey(req.principal!), ...(accessJwt ? { accessJwt } : {}), ...(self ? { accountSelf: true, clientKey: req.ip, ...(req.body.password ? { password: req.body.password } : {}) } : {}) },
        req.audit,
      );
      return { confirm: out.challenge, ...(out.confirmToken ? { confirmToken: out.confirmToken } : {}) };
    },
  );
}
