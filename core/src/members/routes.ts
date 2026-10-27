import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemberService, MemberServiceError } from './service.js';
import type { CreateMemberInput, UpdateMemberInput } from './types.js';

export interface RegisterMemberRoutesOptions {
  service: MemberService;
  prefix?: string;
}

/**
 * P0 鉴权钩子占位符（requireOwner）：
 * P0 单用户模式，后续引入登录态与 RBAC 时完善。
 */
export async function requireOwner(req: FastifyRequest): Promise<void> {
  // Hook placeholder for owner authentication
  void req;
}

export async function registerMemberRoutes(
  app: FastifyInstance,
  options: RegisterMemberRoutesOptions,
): Promise<void> {
  const { service, prefix = '/api/members' } = options;

  // Custom error handler for member service errors
  const previousErrorHandler = app.errorHandler;
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof MemberServiceError) {
      void reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    if (previousErrorHandler) {
      previousErrorHandler(error, req, reply);
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: 'Internal Server Error' });
  });

  // GET /api/members
  app.get<{ Querystring: { includeDeleted?: string } }>(
    prefix,
    { preHandler: requireOwner },
    async (req) => {
      const includeDeleted = req.query.includeDeleted === 'true';
      const members = await service.list({ includeDeleted });
      return { members };
    },
  );

  // GET /api/members/:id
  app.get<{ Params: { id: string } }>(
    `${prefix}/:id`,
    { preHandler: requireOwner },
    async (req) => {
      const member = await service.getById(req.params.id);
      return { member };
    },
  );

  // POST /api/members
  app.post<{ Body: CreateMemberInput }>(
    prefix,
    { preHandler: requireOwner },
    async (req, reply) => {
      const member = await service.create(req.body);
      void reply.status(201);
      return { member };
    },
  );

  // PUT /api/members/:id
  app.put<{ Params: { id: string }; Body: UpdateMemberInput }>(
    `${prefix}/:id`,
    { preHandler: requireOwner },
    async (req) => {
      const member = await service.update(req.params.id, req.body);
      return { member };
    },
  );

  // PATCH /api/members/:id
  app.patch<{ Params: { id: string }; Body: UpdateMemberInput }>(
    `${prefix}/:id`,
    { preHandler: requireOwner },
    async (req) => {
      const member = await service.update(req.params.id, req.body);
      return { member };
    },
  );

  // DELETE /api/members/:id (Soft delete or hard delete if purge query param set)
  app.delete<{
    Params: { id: string };
    Querystring: { purge?: string };
    Body?: { confirm?: boolean };
  }>(
    `${prefix}/:id`,
    { preHandler: requireOwner },
    async (req, reply) => {
      if (req.query.purge === 'true') {
        const confirm = Boolean(req.body?.confirm);
        await service.purge(req.params.id, confirm);
        void reply.status(200).send({ success: true });
        return;
      }

      const member = await service.softDelete(req.params.id);
      return { member };
    },
  );

  // POST /api/members/:id/restore
  app.post<{ Params: { id: string } }>(
    `${prefix}/:id/restore`,
    { preHandler: requireOwner },
    async (req) => {
      const member = await service.restore(req.params.id);
      return { member };
    },
  );

  // POST /api/members/:id/purge or DELETE /api/members/:id/purge
  const handlePurge = async (
    req: FastifyRequest<{ Params: { id: string }; Body?: { confirm?: boolean } }>,
    reply: import('fastify').FastifyReply,
  ) => {
    const confirm = Boolean(req.body?.confirm);
    await service.purge(req.params.id, confirm);
    void reply.status(200).send({ success: true });
  };

  app.post<{ Params: { id: string }; Body?: { confirm?: boolean } }>(
    `${prefix}/:id/purge`,
    { preHandler: requireOwner },
    handlePurge,
  );

  app.delete<{ Params: { id: string }; Body?: { confirm?: boolean } }>(
    `${prefix}/:id/purge`,
    { preHandler: requireOwner },
    handlePurge,
  );

  // POST /api/members/:id/pin
  app.post<{ Params: { id: string } }>(
    `${prefix}/:id/pin`,
    { preHandler: requireOwner },
    async (req) => {
      const member = await service.setPinned(req.params.id, true);
      return { member };
    },
  );

  // POST /api/members/:id/unpin
  app.post<{ Params: { id: string } }>(
    `${prefix}/:id/unpin`,
    { preHandler: requireOwner },
    async (req) => {
      const member = await service.setPinned(req.params.id, false);
      return { member };
    },
  );

  // POST /api/members/reorder
  app.post<{ Body: { ids: string[] } }>(
    `${prefix}/reorder`,
    { preHandler: requireOwner },
    async (req) => {
      const ids = req.body?.ids;
      const members = await service.reorder(ids);
      return { members };
    },
  );
}
