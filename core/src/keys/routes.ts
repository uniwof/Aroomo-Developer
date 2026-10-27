/**
 * Key 管理 API（前缀 /api/keys，Issue #6）。
 * 响应用 schema 序列化：只输出白名单字段（id、名称、获取网址、末 4 位、状态、更新时间），
 * 即使将来有人往记录里加了字段，也不会被带进响应。
 */
import type { FastifyInstance } from 'fastify';
import { requireCapability } from '../auth/plugin.js';
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
const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } } } as const;

export function registerKeyRoutes(app: FastifyInstance, svc: KeysService): void {
  app.get(
    '/api/keys',
    {
      preHandler: requireCapability('keys:read'),
      schema: { response: { 200: { type: 'object', properties: { keys: { type: 'array', items: keyOut } } } } },
    },
    async () => ({ keys: (await svc.list()).map(keyJson) }),
  );

  app.post<{ Body: CreateKeyInput }>(
    '/api/keys',
    {
      preHandler: requireCapability('keys:write'),
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
          },
        },
        response: { 201: { type: 'object', properties: { key: keyOut } } },
      },
    },
    async (req, reply) => reply.status(201).send({ key: keyJson(await svc.create(req.body, req.audit)) }),
  );

  app.patch<{ Params: { id: string }; Body: UpdateKeyInput }>(
    '/api/keys/:id',
    {
      preHandler: requireCapability('keys:write'),
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
          },
        },
        response: { 200: { type: 'object', properties: { key: keyOut } } },
      },
    },
    async (req) => ({ key: keyJson(await svc.update(req.params.id, req.body, req.audit)) }),
  );

  app.delete<{ Params: { id: string }; Body: { confirm?: boolean } | undefined }>(
    '/api/keys/:id',
    {
      preHandler: requireCapability('keys:delete'),
      schema: { params: idParam, body: { type: ['object', 'null'], additionalProperties: false, properties: { confirm: { type: 'boolean' } } } },
    },
    async (req, reply) => {
      await svc.delete(req.params.id, req.body?.confirm === true, req.audit);
      return reply.status(204).send();
    },
  );
}
