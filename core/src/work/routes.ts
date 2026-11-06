/**
 * /work 项目与版本接口（切片 1，docs/api/design-work-v1.md）。v1 只给所有者范围（所有者令牌 / 方案 A 的所有者账号）；
 * 家人账号 403；能力 work:manage 不进操作员白名单。权限在 preValidation 判，先 403 再校验请求体。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { guard, scopeOf } from '../auth/plugin.js';
import { HttpError } from '../http/errors.js';
import type { WorkService } from './service.js';
import type { WorkProject, WorkVersion } from './types.js';

function ownerOnly() {
  const g = guard('work:manage', { user: true });
  return {
    config: g.config,
    preValidation: async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      await g.preHandler.call(this, req, reply);
      if (scopeOf(req) !== 'owner') {
        await req.audit('auth.denied', { type: 'route', id: req.routeOptions.url ?? '' }, 'denied', `${req.method} /work 第一版只给所有者`);
        throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
      }
    },
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const projectJson = (p: WorkProject) => ({ id: p.id, name: p.name, status: p.status, sources: p.sources, lastSyncAt: iso(p.lastSyncAt), createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) });
const versionJson = (v: WorkVersion) => ({
  id: v.id,
  projectId: v.projectId,
  label: v.label,
  title: v.title,
  actor: v.actor,
  artifacts: v.artifacts,
  sourceType: v.sourceType,
  sourceState: v.sourceState,
  sourceAt: iso(v.sourceAt),
  syncedAt: iso(v.syncedAt),
});

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } as const;
const sources = { type: 'array', maxItems: 5, items: { type: 'object', required: ['type', 'repo'], additionalProperties: false, properties: { type: { const: 'github' }, repo: { type: 'string', maxLength: 141 } } } } as const;
const createBody = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 200 }, sources } } as const;
const patchBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: { name: { type: 'string', maxLength: 200 }, status: { type: 'string', enum: ['active', 'paused', 'done'] }, sources },
} as const;

export function registerWorkRoutes(app: FastifyInstance, svc: WorkService): void {
  const g = ownerOnly();

  app.get('/api/work/projects', { ...g }, async (req) => ({
    projects: (await svc.list(scopeOf(req))).map(({ project, latest }) => ({
      ...projectJson(project),
      latest: latest ? { id: latest.id, label: latest.label, sourceState: latest.sourceState, sourceAt: iso(latest.sourceAt) } : null,
    })),
  }));

  app.post<{ Body: { name: string; sources?: unknown } }>('/api/work/projects', { ...g, schema: { body: createBody } }, async (req, reply) =>
    reply.status(201).send({ project: projectJson(await svc.create(scopeOf(req), req.body, req.audit)) }),
  );

  app.get<{ Params: { id: string } }>('/api/work/projects/:id', { ...g, schema: { params: idParam } }, async (req) => ({
    project: projectJson(await svc.get(scopeOf(req), req.params.id)),
  }));

  app.patch<{ Params: { id: string }; Body: { name?: string; status?: string; sources?: unknown } }>(
    '/api/work/projects/:id',
    { ...g, schema: { params: idParam, body: patchBody } },
    async (req) => ({ project: projectJson(await svc.update(scopeOf(req), req.params.id, req.body, req.audit)) }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/work/projects/:id/sync',
    { ...g, schema: { params: idParam, body: { type: ['object', 'null'], additionalProperties: false, properties: {} } } },
    async (req) => svc.sync(scopeOf(req), req.params.id, req.audit),
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/api/work/projects/:id/versions',
    { ...g, schema: { params: idParam, querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 200 } } } } },
    async (req) => {
      const r = await svc.versions(scopeOf(req), req.params.id, req.query.cursor);
      return { versions: r.versions.map(versionJson), nextCursor: r.nextCursor };
    },
  );

  app.get<{ Params: { id: string } }>('/api/work/versions/:id', { ...g, schema: { params: idParam } }, async (req) => ({
    version: versionJson(await svc.version(scopeOf(req), req.params.id)),
  }));
}
