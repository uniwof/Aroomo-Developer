import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { keyRoutes } from './keys/routes.js';
import type { LiteLLMAdminClient } from './keys/litellm.js';
import type { KeyStore } from './keys/store.js';
import { route } from './router/route.js';
import type { RoutableMember } from './router/types.js';

export const VERSION = '0.0.1';

interface RoutePreviewBody {
  text: string;
  members: RoutableMember[];
  leadId?: string | null;
}

export interface ServerOptions {
  keyStore?: KeyStore;
  litellmClient?: LiteLLMAdminClient;
}

export function buildServer(cfg: CoreConfig, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      cfg.logLevel === 'silent'
        ? false
        : {
            level: cfg.logLevel,
            // 防止密钥进日志（PRODUCT 0.4）
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.body.apiKey',
              'req.body.api_key',
              '*.apiKey',
              '*.api_key',
            ],
          },
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'aroomo-core', version: VERSION }));

  // Key 管理 API（PRODUCT §8.3、DECISIONS v4.3）
  app.register(keyRoutes, {
    config: cfg,
    store: opts.keyStore,
    client: opts.litellmClient,
  });

  /**
   * 路由预览（内部接口，P0 骨架）：给定输入和成员列表，返回路由计划，不调用任何模型。
   * 只在容器网络内可达；对外入口由后续 Issue 加鉴权后再开放。
   */
  app.post<{ Body: RoutePreviewBody }>(
    '/internal/route-preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text', 'members'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', maxLength: 20000 },
            leadId: { type: ['string', 'null'] },
            members: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['id', 'name', 'enabled'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 128 },
                  name: { type: 'string', minLength: 1, maxLength: 128 },
                  aliases: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (req) => route(req.body.text, { members: req.body.members, leadId: req.body.leadId ?? null }),
  );

  return app;
}
