/** 确认卡的服务端接口（DECISIONS D63；约定见 docs/architecture/CONFIRM-CARD.md）。只有主人能用。 */
import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';
import { actorKey } from '../auth/tokens.js';
import type { ConfirmService } from './confirm.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } } } as const;

export function registerConfirmRoutes(app: FastifyInstance, svc: ConfirmService): void {
  app.get<{ Params: { id: string } }>(
    '/api/confirm/:id',
    { ...guard('confirm:important'), schema: { params: idParam } },
    async (req) => ({ confirm: await svc.get(req.params.id, actorKey(req.principal!)) }),
  );

  app.post<{ Params: { id: string }; Body: { step: 1 | 2 } }>(
    '/api/confirm/:id/steps',
    {
      ...guard('confirm:important'),
      schema: {
        params: idParam,
        body: { type: 'object', required: ['step'], additionalProperties: false, properties: { step: { type: 'integer', enum: [1, 2] } } },
      },
    },
    async (req) => {
      const h = req.headers['cf-access-jwt-assertion'];
      const accessJwt = typeof h === 'string' && h.length > 0 ? h : undefined;
      const out = await svc.step(req.params.id, req.body.step, { actor: actorKey(req.principal!), ...(accessJwt ? { accessJwt } : {}) }, req.audit);
      return { confirm: out.challenge, ...(out.confirmToken ? { confirmToken: out.confirmToken } : {}) };
    },
  );
}
