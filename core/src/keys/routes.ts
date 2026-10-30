/**
 * Key 管理 API（前缀 /api/keys，Issue #6）。
 * 响应用 schema 序列化：只输出白名单字段（id、名称、获取网址、末 4 位、状态、更新时间），
 * 即使将来有人往记录里加了字段，也不会被带进响应。
 */
import type { FastifyInstance } from 'fastify';
import { confirmCtx, guard } from '../auth/plugin.js';
import { type CreateKeyInput, keyJson, type KeysService, type UpdateKeyInput } from './service.js';

const keyOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    sourceUrl: { type: 'string' },
    last4: { type: 'string' },
    status: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const httpUrl = { type: 'string', maxLength: 2048, pattern: '^https?://[^\\s]+$' } as const;
const apiKey = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const model = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:/@+-]+$' } as const;
const confirmToken = { type: 'string', minLength: 1, maxLength: 128 } as const;
const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } } } as const;

export function registerKeyRoutes(app: FastifyInstance, svc: KeysService): void {
  app.get(
    '/api/keys',
    {
      ...guard('keys:read'),
      schema: { response: { 200: { type: 'object', properties: { keys: { type: 'array', items: keyOut } } } } },
    },
    async () => ({ keys: (await svc.list()).map(keyJson) }),
  );

  app.post<{ Body: CreateKeyInput & { confirmToken?: string } }>(
    '/api/keys',
    {
      ...guard('keys:write'),
      schema: {
        body: {
          type: 'object',
          required: ['name', 'sourceUrl', 'apiKey', 'model'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            sourceUrl: httpUrl,
            apiKey,
            model,
            modelName: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:/@+ -]+$' },
            apiBase: httpUrl,
            confirmToken,
          },
        },
        response: { 201: { type: 'object', properties: { key: keyOut } } },
      },
    },
    async (req, reply) => {
      const { confirmToken: t, ...input } = req.body;
      return reply.status(201).send({ key: keyJson(await svc.create(input, confirmCtx(req.principal!, t), req.audit)) });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateKeyInput & { confirmToken?: string } }>(
    '/api/keys/:id',
    {
      ...guard('keys:write'),
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            sourceUrl: httpUrl,
            apiKey,
            model,
            apiBase: { anyOf: [httpUrl, { type: 'null' }] },
            confirmToken,
          },
        },
        response: { 200: { type: 'object', properties: { key: keyOut } } },
      },
    },
    async (req) => {
      const { confirmToken: t, ...patch } = req.body;
      return { key: keyJson(await svc.update(req.params.id, patch, confirmCtx(req.principal!, t), req.audit)) };
    },
  );

  app.delete<{ Params: { id: string }; Body: { confirmToken?: string } | undefined }>(
    '/api/keys/:id',
    {
      ...guard('keys:delete'),
      schema: { params: idParam, body: { type: ['object', 'null'], additionalProperties: false, properties: { confirmToken } } },
    },
    async (req, reply) => {
      await svc.delete(req.params.id, confirmCtx(req.principal!, req.body?.confirmToken), req.audit);
      return reply.status(204).send();
    },
  );
}
