import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuditRoutes } from './audit/routes.js';
import { installAuth } from './auth/plugin.js';
import { createTokenVerifier } from './auth/tokens.js';
import type { CoreConfig } from './config.js';
import { type CoreDeps, memoryDeps } from './deps.js';
import { installErrorHandler } from './http/errors.js';
import { registerMemberRoutes } from './members/routes.js';
import { MembersService } from './members/service.js';
import { route } from './router/route.js';
import type { RoutableMember } from './router/types.js';

export const VERSION = '0.0.1';

interface RoutePreviewBody {
  text: string;
  members: RoutableMember[];
  leadId?: string | null;
}

export function buildServer(cfg: CoreConfig, deps: CoreDeps = memoryDeps()): FastifyInstance {
  const app = Fastify({
    // 未声明的字段直接 400，而不是悄悄丢掉（Key 等敏感接口不接受「多余但被忽略」的输入）
    ajv: { customOptions: { removeAdditional: false } },
    logger:
      cfg.logLevel === 'silent'
        ? false
        : {
            level: cfg.logLevel,
            // 防止密钥进日志（PRODUCT 0.4）
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-api-key"]',
                'req.body.apiKey',
                'body.apiKey',
                'apiKey',
                '*.apiKey',
              ],
              censor: '[REDACTED]',
            },
          },
  });

  installErrorHandler(app);
  installAuth(app, {
    verify: createTokenVerifier({
      ownerToken: cfg.ownerToken,
      tokenSecret: cfg.tokenSecret,
      operatorTokens: deps.operatorTokens,
      now: deps.now,
    }),
    auditLog: deps.auditLog,
    ownerConfigured: Boolean(cfg.ownerToken),
  });
  if (deps.db) {
    const db = deps.db;
    app.addHook('onClose', async () => db.close());
  }

  app.get('/healthz', async () => ({ status: 'ok', service: 'aroomo-core', version: VERSION }));

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

  registerAuditRoutes(app, deps.auditLog);
  registerMemberRoutes(app, new MembersService(deps.members, deps.now));

  return app;
}
