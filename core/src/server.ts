import { VaultService } from './vault/service.js';
import { registerVaultRoutes } from './vault/routes.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMcpConfigRoutes } from './mcpconfig/routes.js';
import { registerAuditRoutes } from './audit/routes.js';
import { installAuth } from './auth/plugin.js';
import { createTokenVerifier } from './auth/tokens.js';
import type { CoreConfig } from './config.js';
import { type CoreDeps, memoryDeps } from './deps.js';
import { CfAccessVerifier } from './confirm/access.js';
import { ConfirmService } from './confirm/confirm.js';
import { registerConfirmRoutes } from './confirm/routes.js';
import { installErrorHandler } from './http/errors.js';
import { scrubForLog } from './http/scrub.js';
import { registerInboxRoutes } from './inbox/routes.js';
import { InboxService } from './inbox/service.js';
import { LiteLLMAdmin } from './keys/litellm.js';
import { registerKeyRoutes } from './keys/routes.js';
import { KeysService } from './keys/service.js';
import { registerMemberRoutes } from './members/routes.js';
import { MembersService } from './members/service.js';
import { route } from './router/route.js';
import { LeadService } from './settings/lead.js';
import { ChatService } from './chat/service.js';
import { registerChatRoutes } from './chat/routes.js';
import { Scheduler } from './jobs/scheduler.js';
import { confirmCleanupJob, keyReconcileJob, modelCapsJob, recycleBinJob } from './jobs/jobs.js';
import { CandidateFlow } from './members/candidates.js';
import { refreshModelCaps } from './members/caps.js';
import { SecurityService } from './settings/security.js';
import { scopedSettings } from './settings/store.js';
import { bindAudit } from './audit/common.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { PubMemService } from './pubmem/service.js';
import { registerPubMemRoutes } from './pubmem/routes.js';
import { ClientTokenService } from './clients/service.js';
import { registerClientRoutes } from './clients/routes.js';
import { UsersService } from './users/service.js';
import { registerUserRoutes } from './users/routes.js';
import { registerConsole } from './console/static.js';
import type { RoutableMember } from './router/types.js';

export const VERSION = '0.0.1';

declare module 'fastify' {
  interface FastifyInstance {
    inbox: InboxService;
    jobs: Scheduler;
  }
}

interface RoutePreviewBody {
  text: string;
  members: RoutableMember[];
  leadId?: string | null;
  sensitive?: boolean;
}

export interface BuildOptions {
  /** 启动定时任务（默认按 CORE_JOBS；测试里不启动，用 app.jobs.runOnce() 手动跑） */
  startJobs?: boolean;
  /** 日志输出目标（测试用来捕获日志，检查有没有泄露 Key） */
  logStream?: { write(msg: string): void };
}

export function buildServer(cfg: CoreConfig, deps: CoreDeps = memoryDeps(), opts: BuildOptions = {}): FastifyInstance {
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
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
  });

  installErrorHandler(app);
  // trace 级别记录 /api 请求体，便于排障；apiKey 等字段由上面的 redact 规则替换为 [REDACTED]
  app.addHook('preValidation', async (req) => {
    if (req.url.startsWith('/api/') && req.body !== undefined && req.log.level === 'trace') {
      req.log.trace({ body: scrubForLog(req.body) }, 'request body');
    }
  });
  const users = new UsersService(deps.users, deps.now);
  const clients = new ClientTokenService(deps.clients, deps.now);
  const verifyStatic = createTokenVerifier({
    ownerToken: cfg.ownerToken,
    tokenSecret: cfg.tokenSecret,
    operatorTokens: deps.operatorTokens,
    now: deps.now,
  });
  installAuth(app, {
    // 主人令牌 / 操作员令牌 / 账号会话令牌（ars_ 开头）
    verify: async (token) => (await verifyStatic(token)) ?? (await users.verifySession(token)) ?? (await clients.verify(token)),
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
            sensitive: { type: 'boolean' },
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
                  external: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (req) =>
      route(req.body.text, { members: req.body.members, leadId: req.body.leadId ?? null, sensitive: req.body.sensitive === true }),
  );

  // 统一确认服务（D63）：所有需要确认的操作共用这一个实例
  const access =
    deps.access ??
    (cfg.cfAccessTeamDomain && cfg.cfAccessAud ? new CfAccessVerifier({ teamDomain: cfg.cfAccessTeamDomain, aud: cfg.cfAccessAud, now: deps.now }) : undefined);
  const confirm = new ConfirmService(deps.confirmChallenges, {
    now: deps.now,
    reauth: cfg.accessReauth,
    reauthMaxAgeS: cfg.accessReauthMaxAgeS,
    ...(access ? { access } : {}),
  });
  registerConfirmRoutes(app, confirm);

  registerUserRoutes(app, users, deps.auditLog);
  // 控制台静态文件 /console（D195，控制台线）
  registerConsole(app);
  registerVaultRoutes(app, new VaultService(cfg.vaultKey, deps.vault, deps.now, confirm));
  registerClientRoutes(app, clients);
  registerPubMemRoutes(app, new PubMemService(deps.pubmem, deps.now));
  registerAuditRoutes(app, deps.auditLog);
  registerMcpConfigRoutes(app);
  const litellm = deps.litellm ?? new LiteLLMAdmin({ baseUrl: cfg.litellmBaseUrl, masterKey: cfg.litellmMasterKey });
  const members = new MembersService(deps.members, deps.now, confirm);
  const inbox = new InboxService(deps.inbox, confirm, deps.now);
  // 供其他模块调用 createInboxItem()
  app.decorate('inbox', inbox);
  registerInboxRoutes(app, inbox);
  // 入职流程（PRODUCT §9.1）：加 Key → 候选 → 一键入职
  const candidates = new CandidateFlow(members, deps.members, inbox, litellm, deps.now);
  // 账号用户的成员服务：同一份数据里本人的视图（D111）。账号用户没有候选 / 入职流程（那条链路还是所有者全局的，B1b 后续再隔离）
  const userMembers = new Map<string, MembersService>();
  const membersForUser = (userId: string): MembersService => {
    let svc = userMembers.get(userId);
    if (!svc) {
      svc = new MembersService(deps.members.forUser(userId), deps.now, confirm);
      userMembers.set(userId, svc);
    }
    return svc;
  };
  registerMemberRoutes(app, members, {
    onboard: (id, audit) => candidates.onboard(id, audit),
    afterCreate: async (m) => {
      await refreshModelCaps(deps.members, litellm, deps.now, [m.name]).catch(() => 0);
      return (await deps.members.get(m.id)) ?? m;
    },
  }, membersForUser);
  const lead = new LeadService(deps.settings, deps.members, deps.now);
  const security = new SecurityService(deps.settings, deps.now);
  const userLeads = new Map<string, LeadService>();
  const leadForUser = (userId: string): LeadService => {
    let svc = userLeads.get(userId);
    if (!svc) {
      svc = new LeadService(scopedSettings(deps.settings, userId), deps.members.forUser(userId), deps.now);
      userLeads.set(userId, svc);
    }
    return svc;
  };
  registerSettingsRoutes(app, lead, security, leadForUser);
  // 对话入口（提议 H5）：LobeHub → Core /v1（D31 点名 / 交给负责人）→ LiteLLM
  registerChatRoutes(
    app,
    new ChatService({
      litellmBaseUrl: cfg.litellmBaseUrl,
      litellmKey: cfg.litellmMasterKey,
      listMembers: () => deps.members.listAll(),
      lead,
      security,
      ...(deps.chatFetch ? { fetchImpl: deps.chatFetch } : {}),
    }),
    cfg.chatToken,
  );
  registerKeyRoutes(
    app,
    new KeysService(deps.keys, litellm, deps.now, confirm, {
      // 新 Key 的模型先进候选（名字 = LiteLLM 里对外的模型名），收件箱发「入职」卡片；同名成员已存在则只刷新模型事实
      afterCreate: async (rec, audit) => {
        await candidates.propose(rec.modelName, audit);
      },
      afterReplace: async (rec) => {
        await refreshModelCaps(deps.members, litellm, deps.now, [rec.modelName]);
      },
      // 这个模型已经没有任何 Key：停用对应成员（可以在成员页重新启用）
      afterDelete: async (rec, audit) => {
        const same = (n: string) => n.toLowerCase() === rec.modelName.toLowerCase();
        if ((await deps.keys.list()).some((k) => same(k.modelName))) return;
        const m = (await members.list()).find((x) => same(x.name) && x.enabled);
        if (m) await members.update(m.id, { enabled: false }, audit);
      },
    }),
  );

  // 定时任务（回收站 30 天、过期确认清理、Key 对账）
  const jobs = new Scheduler(bindAudit(deps.auditLog, { type: 'system', id: 'jobs' }));
  jobs.add(recycleBinJob(async () => [members, ...(await deps.members.userIds()).filter((u) => u !== 'owner').map(membersForUser)]));
  jobs.add(confirmCleanupJob(deps.confirmChallenges, deps.now));
  jobs.add(keyReconcileJob(deps.keys, litellm, inbox, deps.now));
  jobs.add(modelCapsJob(deps.members, litellm, deps.now));
  app.decorate('jobs', jobs);
  if (opts.startJobs ?? cfg.jobs) {
    app.addHook('onReady', async () => jobs.start());
  }
  app.addHook('onClose', async () => jobs.stop());

  return app;
}
