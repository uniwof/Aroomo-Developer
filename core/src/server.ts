import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { registerMemberRoutes } from './members/routes.js';
import { MemberService } from './members/service.js';
import { InMemoryMemberStore } from './members/store.js';
import type { MemberStore } from './members/types.js';
import { route } from './router/route.js';
import type { RoutableMember } from './router/types.js';

export const VERSION = '0.0.1';

interface RoutePreviewBody {
  text: string;
  members: RoutableMember[];
  leadId?: string | null;
}

export interface BuildServerOptions {
  memberStore?: MemberStore;
  audit?: import('./members/types.js').AuditFn;
}

export function buildServer(
  cfg: CoreConfig,
  options?: BuildServerOptions,
): FastifyInstance {
  const app = Fastify({
    logger:
      cfg.logLevel === 'silent'
        ? false
        : {
            level: cfg.logLevel,
            // 防止密钥进日志（PRODUCT 0.4）
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
          },
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'aroomo-core', version: VERSION }));

  // Member Management Module Integration
  const store = options?.memberStore ?? new InMemoryMemberStore();
  const memberService = new MemberService({
    store,
    audit: options?.audit,
  });
  void registerMemberRoutes(app, { service: memberService });

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
