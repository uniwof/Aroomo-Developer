/**
 * 助手接口（前缀 /api/assistants；指南 v1.1 7.11/7.12/附录 C；docs/api/design-assistants-v1.md §2）。
 * 第一版只给所有者：所有者令牌，或方案 A 的所有者账号（scopeOf = 'owner'）。家人账号、操作员、客户端令牌一律 403 并写审计。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { confirmCtx, guard, scopeOf } from '../auth/plugin.js';
import type { Capability } from '../auth/capabilities.js';
import { HttpError } from '../http/errors.js';
import type { AssistantInput, AssistantPatch, AssistantService } from './service.js';
import { assistantJson, runJson } from './service.js';
import { BUDGET_LEVELS, CATCH_UPS, SCHEDULE_KINDS } from './types.js';

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: UUID } } as const;
const runParams = { type: 'object', required: ['id', 'run'], properties: { id: UUID, run: UUID } } as const;
const IDEM_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const scheduleSchema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...SCHEDULE_KINDS] },
    time: { type: 'string', maxLength: 5 },
    days: { type: 'array', maxItems: 7, items: { type: 'integer' } },
    everyHours: { type: 'integer' },
  },
} as const;

const fields = {
  name: { type: 'string', maxLength: 200 },
  instructions: { type: 'string', maxLength: 8000 },
  members: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } },
  leadMemberId: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
  schedule: scheduleSchema,
  timezone: { type: 'string', maxLength: 64 },
  catchUp: { type: 'string', enum: [...CATCH_UPS] },
  maxRuntimeSec: { type: 'integer' },
  budgetLevel: { type: 'string', enum: [...BUDGET_LEVELS] },
  notify: { type: 'boolean' },
  enabled: { type: 'boolean' },
} as const;
// 未声明的字段（含调用方自带的作者 / 成员身份，X-23 ②）一律 400：服务器 ajv 不删多余字段
const createBody = { type: 'object', required: ['name', 'instructions', 'members', 'schedule'], additionalProperties: false, properties: fields } as const;
const patchBody = { type: 'object', minProperties: 1, additionalProperties: false, properties: fields } as const;
const emptyBody = { type: ['object', 'null'], additionalProperties: false, properties: {} } as const;

function idemKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !IDEM_RE.test(raw)) throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key 只能是 1–128 位字母、数字和 . _ : -');
  return raw;
}

/** 能力声明（操作员白名单检查）+ 账号可进（userRoute）+ 只放行所有者范围。放在 preValidation：先判权限再校验请求体，家人账号一律 403 而不是 400 */
function ownerOnly(cap: Capability) {
  const g = guard(cap, { user: true });
  return {
    config: g.config,
    preValidation: async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      await g.preHandler.call(this, req, reply);
      if (scopeOf(req) !== 'owner') {
        await req.audit('auth.denied', { type: 'route', id: req.routeOptions.url ?? '' }, 'denied', `${req.method} 助手第一版只给所有者`);
        throw new HttpError(403, 'FORBIDDEN', '没有权限执行这个操作');
      }
    },
  };
}

export function registerAssistantRoutes(app: FastifyInstance, svc: AssistantService): void {
  const read = ownerOnly('assistants:read');
  const write = ownerOnly('assistants:write');

  app.get('/api/assistants', { ...read }, async (req) => ({ assistants: await svc.list(scopeOf(req)) }));

  app.post<{ Body: AssistantInput }>('/api/assistants', { ...write, schema: { body: createBody } }, async (req, reply) => {
    const out = await svc.create(scopeOf(req), req.body, idemKey(req), req.audit);
    return reply.status(out.created ? 201 : 200).send({ assistant: await svc.get(scopeOf(req), out.assistant.id), created: out.created });
  });

  app.post<{ Body: AssistantInput }>('/api/assistants/preview', { ...read, schema: { body: createBody } }, async (req) => svc.preview(scopeOf(req), req.body));

  app.get<{ Params: { id: string } }>('/api/assistants/:id', { ...read, schema: { params: idParams } }, async (req) => ({ assistant: await svc.get(scopeOf(req), req.params.id) }));

  app.patch<{ Params: { id: string }; Body: AssistantPatch }>('/api/assistants/:id', { ...write, schema: { params: idParams, body: patchBody } }, async (req) => {
    await svc.update(scopeOf(req), req.params.id, req.body, req.audit);
    return { assistant: await svc.get(scopeOf(req), req.params.id) };
  });

  app.delete<{ Params: { id: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/assistants/:id',
    {
      ...write,
      schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { confirmToken: { type: 'string', minLength: 1, maxLength: 128 } } } },
    },
    async (req, reply) => {
      await svc.delete(scopeOf(req), req.params.id, confirmCtx(req.principal!, req.body?.confirmToken), req.audit);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>('/api/assistants/:id/pause', { ...write, schema: { params: idParams, body: emptyBody } }, async (req) => ({
    assistant: assistantJson(await svc.pause(scopeOf(req), req.params.id, req.audit)),
  }));
  app.post<{ Params: { id: string } }>('/api/assistants/:id/resume', { ...write, schema: { params: idParams, body: emptyBody } }, async (req) => ({
    assistant: assistantJson(await svc.resume(scopeOf(req), req.params.id, req.audit)),
  }));

  /** 立即运行：202 = 新建并开始；200 = 同一个幂等键的重复请求，返回原来那条 */
  app.post<{ Params: { id: string } }>('/api/assistants/:id/runs', { ...write, schema: { params: idParams, body: emptyBody } }, async (req, reply) => {
    const out = await svc.runNow(scopeOf(req), req.params.id, idemKey(req), req.audit);
    return reply.status(out.created ? 202 : 200).send({ run: runJson(out.run), created: out.created });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    '/api/assistants/:id/runs',
    {
      ...read,
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', format: 'date-time' } } },
      },
    },
    async (req) => svc.runs(scopeOf(req), req.params.id, req.query.limit ?? 20, req.query.before ? new Date(req.query.before) : undefined),
  );

  app.get<{ Params: { id: string; run: string } }>('/api/assistants/:id/runs/:run', { ...read, schema: { params: runParams } }, async (req) => ({
    run: await svc.run(scopeOf(req), req.params.id, req.params.run),
  }));

  app.post<{ Params: { id: string; run: string } }>('/api/assistants/:id/runs/:run/cancel', { ...write, schema: { params: runParams, body: emptyBody } }, async (req) => ({
    run: runJson(await svc.cancelRun(scopeOf(req), req.params.id, req.params.run, req.audit)),
  }));

  app.get<{ Params: { id: string }; Querystring: { limit?: number; afterSeq?: number } }>(
    '/api/assistants/:id/messages',
    {
      ...read,
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 }, afterSeq: { type: 'integer', minimum: 0 } } },
      },
    },
    async (req) => svc.messages(scopeOf(req), req.params.id, req.query.limit ?? 100, req.query.afterSeq),
  );

  app.post<{ Params: { id: string } }>('/api/assistants/:id/read', { ...write, schema: { params: idParams, body: emptyBody } }, async (req, reply) => {
    await svc.markRead(scopeOf(req), req.params.id);
    return reply.status(204).send();
  });
}
