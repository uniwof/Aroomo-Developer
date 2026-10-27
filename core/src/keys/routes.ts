import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { CoreConfig } from '../config.js';
import { LiteLLMAdminClient, LiteLLMError } from './litellm.js';
import { KeyMetadata, KeyStore, MemoryKeyStore } from './store.js';

export interface KeyRoutesOptions {
  config: CoreConfig;
  store?: KeyStore;
  client?: LiteLLMAdminClient;
}

interface CreateKeyBody {
  sourceUrl: string;
  name: string;
  apiKey: string;
  apiBase?: string;
}

interface UpdateKeyBody {
  sourceUrl?: string;
  name?: string;
  apiKey?: string;
  apiBase?: string;
}

interface DeleteKeyBody {
  confirm?: boolean;
}

export function getLast4(key: string): string {
  if (key.length <= 4) {
    return key;
  }
  return key.slice(-4);
}

export function toPublicMetadata(item: KeyMetadata): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    sourceUrl: item.sourceUrl,
    last4: item.last4,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export const defaultKeyStore = new MemoryKeyStore();

export const keyRoutes: FastifyPluginAsync<KeyRoutesOptions> = async (fastify, opts) => {
  const store = opts.store ?? defaultKeyStore;
  const client =
    opts.client ?? new LiteLLMAdminClient(opts.config.litellmBaseUrl, opts.config.litellmMasterKey);

  // 全局 LiteLLM 错误处理器：防止透传包含 API Key 的错误
  fastify.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof LiteLLMError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }

    const errObj = error as { validation?: unknown; statusCode?: number };
    if (errObj && errObj.validation) {
      reply.status(400).send({ error: '请求参数格式错误' });
      return;
    }

    const statusCode = errObj && typeof errObj.statusCode === 'number' ? errObj.statusCode : 500;
    reply.status(statusCode).send({ error: '服务器内部错误' });
  });

  // POST /api/keys - 新增 Key
  fastify.post<{ Body: CreateKeyBody }>(
    '/api/keys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sourceUrl', 'name', 'apiKey'],
          properties: {
            sourceUrl: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            apiKey: { type: 'string', minLength: 1 },
            apiBase: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { sourceUrl, name, apiKey, apiBase } = req.body;
      const id = `key_${randomUUID()}`;
      const last4 = getLast4(apiKey);
      const modelName = `aroomo-provider-${id}`;

      // 1. 写入 LiteLLM
      const deployment = await client.createModel({
        modelName,
        litellmParams: {
          model: 'openai/*',
          apiKey,
          apiBase: apiBase || sourceUrl,
        },
        modelInfo: {
          key_id: id,
          source_url: sourceUrl,
        },
      });

      // 2. 本地存储非敏感元数据
      let metadata = await store.create({
        id,
        name,
        sourceUrl,
        last4,
        litellmDeploymentId: deployment.id,
        status: 'active',
      });

      // 3. 触发一次「同步模型列表」占位调用（失败只更新状态不抛出异常报错）
      const syncOk = await client.syncModels();
      if (!syncOk) {
        const updated = await store.update(id, { status: 'error' });
        if (updated) {
          metadata = updated;
        }
      }

      reply.status(201).send(toPublicMetadata(metadata));
    },
  );

  // GET /api/keys - 列表
  fastify.get('/api/keys', async () => {
    const list = await store.list();
    return list.map(toPublicMetadata);
  });

  // PUT /api/keys/:id - 修改
  fastify.put<{ Params: { id: string }; Body: UpdateKeyBody }>(
    '/api/keys/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          properties: {
            sourceUrl: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            apiKey: { type: 'string', minLength: 1 },
            apiBase: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await store.get(id);
      if (!existing) {
        reply.status(404).send({ error: '未找到指定的 Key' });
        return;
      }

      const { name, sourceUrl, apiKey, apiBase } = req.body;
      let newLast4 = existing.last4;
      let newStatus = existing.status;

      if (apiKey) {
        newLast4 = getLast4(apiKey);
        const modelName = `aroomo-provider-${id}`;
        await client.updateModel(existing.litellmDeploymentId, {
          modelName,
          litellmParams: {
            model: 'openai/*',
            apiKey,
            apiBase: apiBase || sourceUrl || existing.sourceUrl,
          },
        });
        newStatus = 'active';

        // 刷新模型状态
        const syncOk = await client.syncModels();
        if (!syncOk) {
          newStatus = 'error';
        }
      }

      const updated = await store.update(id, {
        ...(name ? { name } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        last4: newLast4,
        status: newStatus,
      });

      reply.send(toPublicMetadata(updated!));
    },
  );

  // DELETE /api/keys/:id - 删除（需 confirm: true）
  fastify.delete<{ Params: { id: string }; Body: DeleteKeyBody }>(
    '/api/keys/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['confirm'],
          properties: {
            confirm: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { confirm } = req.body || {};

      if (confirm !== true) {
        reply.status(400).send({ error: '必须确认删除 (confirm: true)' });
        return;
      }

      const existing = await store.get(id);
      if (!existing) {
        reply.status(404).send({ error: '未找到指定的 Key' });
        return;
      }

      await client.deleteModel(existing.litellmDeploymentId);
      await store.delete(id);

      reply.send({ success: true });
    },
  );
};
