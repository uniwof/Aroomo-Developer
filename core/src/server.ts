import { VaultService } from "./vault/service.js";
import { registerVaultRoutes } from "./vault/routes.js";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMcpConfigRoutes } from "./mcpconfig/routes.js";
import { CapabilityService } from "./capabilities/service.js";
import { registerCapabilityRoutes } from "./capabilities/routes.js";
import { TrialService, trialExpiryJob } from "./capabilities/trials.js";
import { registerAuditRoutes } from "./audit/routes.js";
import { installAuth } from "./auth/plugin.js";
import { createTokenVerifier } from "./auth/tokens.js";
import type { CoreConfig } from "./config.js";
import { type CoreDeps, memoryDeps } from "./deps.js";
import { CfAccessVerifier } from "./confirm/access.js";
import { ConfirmService } from "./confirm/confirm.js";
import { registerConfirmRoutes } from "./confirm/routes.js";
import { installErrorHandler } from "./http/errors.js";
import { scrubForLog } from "./http/scrub.js";
import { registerInboxRoutes } from "./inbox/routes.js";
import { InboxService } from "./inbox/service.js";
import { LiteLLMAdmin } from "./keys/litellm.js";
import { registerKeyRoutes } from "./keys/routes.js";
import { upstreamNameFor } from "./keys/prefix.js";
import { KeysService } from "./keys/service.js";
import { registerMemberRoutes } from "./members/routes.js";
import { MembersService } from "./members/service.js";
import { route } from "./router/route.js";
import { LeadService } from "./settings/lead.js";
import { ChatService } from "./chat/service.js";
import { UsageService } from "./usage/service.js";
import { registerUsageRoutes } from "./usage/routes.js";
import { registerChatRoutes, type ChatUserRouting } from "./chat/routes.js";
import { registerChatStreamRoute } from "./chat/stream.js";
import { Scheduler } from "./jobs/scheduler.js";
import { inboxTidyJob } from "./inbox/tidy.js";
import {
  confirmCleanupJob,
  keyReconcileJob,
  modelCapsJob,
  taskTimeoutJob,
  recycleBinJob,
} from "./jobs/jobs.js";
import { CandidateFlow } from "./members/candidates.js";
import { refreshModelCaps } from "./members/caps.js";
import { SecurityService } from "./settings/security.js";
import { scopedSettings } from "./settings/store.js";
import { bindAudit } from "./audit/common.js";
import { registerSettingsRoutes } from "./settings/routes.js";
import { PubMemService } from "./pubmem/service.js";
import { registerPubMemRoutes } from "./pubmem/routes.js";
import { LibraryService } from "./library/service.js";
import { registerLibraryRoutes } from "./library/routes.js";
import { registerMcpRoutes } from "./mcp/server.js";
import { ClientTokenService } from "./clients/service.js";
import { registerClientRoutes } from "./clients/routes.js";
import { hasExecutorScope } from "./clients/types.js";
import { ExecutorService } from "./executor/service.js";
import { GatewayService } from "./gateway/service.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { registerExecutorRoutes } from "./executor/routes.js";
import {
  InterruptBudget,
  quietTakeoverExpiryJob,
  registerInterruptBudgetRoutes,
  registerTakeoverHandler,
  takeoverHooks,
} from "./executor/takeover-inbox.js";
import { UsersService } from "./users/service.js";
import { registerUserRoutes } from "./users/routes.js";
import { registerConsole } from "./console/static.js";
import type { RoutableMember } from "./router/types.js";
import { AssistantService } from "./assistants/service.js";
import { detectAssistantIntent } from "./assistants/intent.js";
import { AssistantRunner } from "./assistants/runner.js";
import { registerAssistantRoutes } from "./assistants/routes.js";
import { ConversationService } from "./conversations/service.js";
import { registerConversationRoutes } from "./conversations/routes.js";
import { Compactor, freeSummarizer } from "./conversations/compact.js";
import { PushService } from "./push/service.js";
import { registerPushRoutes } from "./push/routes.js";
import { WorkService } from "./work/service.js";
import { registerWorkRoutes } from "./work/routes.js";
import { assistantSchedulerJob, confirmExpiryJob } from "./scheduler/assistant-scheduler.js";

export const VERSION = "0.0.1";

declare module "fastify" {
  interface FastifyInstance {
    inbox: InboxService;
    jobs: Scheduler;
    assistants: { service: AssistantService; runner: AssistantRunner };
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

export function buildServer(
  cfg: CoreConfig,
  deps: CoreDeps = memoryDeps(),
  opts: BuildOptions = {},
): FastifyInstance {
  const app = Fastify({
    // 只信任配置里的上一跳代理（容器网络里的 Shell / cloudflared）给的 X-Forwarded-For；未配置时 req.ip = 直连地址
    trustProxy: cfg.trustProxy ?? false,
    // 未声明的字段直接 400，而不是悄悄丢掉（Key 等敏感接口不接受「多余但被忽略」的输入）
    ajv: { customOptions: { removeAdditional: false } },
    logger:
      cfg.logLevel === "silent"
        ? false
        : {
            level: cfg.logLevel,
            // 防止密钥进日志（PRODUCT 0.4）
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'req.headers["x-api-key"]',
                "req.body.apiKey",
                "body.apiKey",
                "apiKey",
                "*.apiKey",
              ],
              censor: "[REDACTED]",
            },
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
  });

  installErrorHandler(app);
  // trace 级别记录 /api 请求体，便于排障；apiKey 等字段由上面的 redact 规则替换为 [REDACTED]
  app.addHook("preValidation", async (req) => {
    if (
      req.url.startsWith("/api/") &&
      req.body !== undefined &&
      req.log.level === "trace"
    ) {
      req.log.trace({ body: scrubForLog(req.body) }, "request body");
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
  let ownerAccountId: string | undefined; // 启动检查通过后才有值（见下方 onReady）
  installAuth(app, {
    // 主人令牌 / 操作员令牌 / 账号会话令牌（ars_ 开头）
    verify: async (token) =>
      (await verifyStatic(token)) ??
      (await users.verifySession(token)) ??
      (await clients.verify(token)),
    auditLog: deps.auditLog,
    ownerConfigured: Boolean(cfg.ownerToken),
    ownerAccountId: () => ownerAccountId,
  });
  // 负责人必改 3：启动时核对 CORE_OWNER_ACCOUNT_ID —— 账号存在、是管理员、没停用才开映射；否则整个进程不映射并告警（不阻止启动）
  if (cfg.ownerAccountId) {
    const configured = cfg.ownerAccountId;
    app.addHook("onReady", async () => {
      const u = await deps.users.getUser(configured);
      const why = !u ? "账号不存在" : u.role !== "admin" ? "账号不是管理员" : u.status !== "active" ? "账号已停用" : null;
      if (why) app.log.warn(`CORE_OWNER_ACCOUNT_ID 配置的${why}：不映射到所有者数据（改好后重启 Core）`);
      else ownerAccountId = configured;
    });
  }
  if (deps.db) {
    const db = deps.db;
    app.addHook("onClose", async () => db.close());
  }

  app.get("/healthz", async () => ({
    status: "ok",
    service: "aroomo-core",
    version: VERSION,
  }));

  /**
   * 路由预览（内部接口，P0 骨架）：给定输入和成员列表，返回路由计划，不调用任何模型。
   * 只在容器网络内可达；对外入口由后续 Issue 加鉴权后再开放。
   */
  app.post<{ Body: RoutePreviewBody }>(
    "/internal/route-preview",
    {
      schema: {
        body: {
          type: "object",
          required: ["text", "members"],
          additionalProperties: false,
          properties: {
            text: { type: "string", maxLength: 20000 },
            leadId: { type: ["string", "null"] },
            sensitive: { type: "boolean" },
            members: {
              type: "array",
              maxItems: 500,
              items: {
                type: "object",
                required: ["id", "name", "enabled"],
                additionalProperties: false,
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 128 },
                  name: { type: "string", minLength: 1, maxLength: 128 },
                  aliases: {
                    type: "array",
                    maxItems: 20,
                    items: { type: "string", maxLength: 64 },
                  },
                  enabled: { type: "boolean" },
                  external: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    async (req) =>
      route(req.body.text, {
        members: req.body.members,
        leadId: req.body.leadId ?? null,
        sensitive: req.body.sensitive === true,
      }),
  );

  // 统一确认服务（D63）：所有需要确认的操作共用这一个实例
  const access =
    deps.access ??
    (cfg.cfAccessTeamDomain && cfg.cfAccessAud
      ? new CfAccessVerifier({
          teamDomain: cfg.cfAccessTeamDomain,
          aud: cfg.cfAccessAud,
          now: deps.now,
        })
      : undefined);
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
  const vaultSvc = new VaultService(
    cfg.vaultKey,
    deps.vault,
    deps.now,
    confirm,
  );
  registerVaultRoutes(app, vaultSvc);
  registerClientRoutes(app, clients);
  const inbox = new InboxService(deps.inbox, confirm, deps.now);
  // X-08 推送提醒：PUSH_ENABLED 关着时接口 503、不发推送；只记错误名 / 状态码
  const push = new PushService({
    store: deps.push,
    vapid: cfg.push,
    now: deps.now,
    ...(deps.pushFetch ? { fetch: deps.pushFetch } : {}),
    log: (msg, data) => app.log.warn(data, msg),
  });
  inbox.onCreated((item) => push.notifyInbox(item));
  registerPushRoutes(app, push);
  // /work 项目与版本（切片 1 + 2）：只给所有者；同步只请求 api.github.com，公共记忆和助手按本账号读
  registerWorkRoutes(app, new WorkService(deps.work, deps.now, deps.workFetch ?? fetch, { pubmem: deps.pubmem, assistants: deps.assistants }));
  const interruptBudget = new InterruptBudget((u) => scopedSettings(deps.settings, u), deps.now);
  const executorSvc = new ExecutorService(
    deps.executor,
    deps.now,
    (u, id) => vaultSvc.resolveForGateway(u, id),
    (u) => scopedSettings(deps.settings, u),
    takeoverHooks(inbox, interruptBudget, deps.now),
  );
  const gatewayService = new GatewayService(
      deps.settings,
      confirm,
      deps.now,
      executorSvc,
      (u, id) => vaultSvc.exists(u, id),
      (u, id) => vaultSvc.resolveForGateway(u, id),
    );
  registerGatewayRoutes(app, gatewayService);
  registerTakeoverHandler(inbox, executorSvc);
  registerInterruptBudgetRoutes(app, interruptBudget, inbox);
  registerExecutorRoutes(app, executorSvc);
  const pubMemService = new PubMemService(deps.pubmem, deps.now);
  registerPubMemRoutes(app, pubMemService);
  const libraryService = new LibraryService(deps.library, deps.now);
  registerLibraryRoutes(app, libraryService);
  registerMcpRoutes(app, libraryService, pubMemService, gatewayService, executorSvc, deps.now);
  registerAuditRoutes(app, deps.auditLog);
  registerMcpConfigRoutes(app);
  registerCapabilityRoutes(app, new CapabilityService(), (u) => new TrialService(scopedSettings(deps.settings, u), deps.now));
  const litellm =
    deps.litellm ??
    new LiteLLMAdmin({
      baseUrl: cfg.litellmBaseUrl,
      masterKey: cfg.litellmMasterKey,
    });
  const members = new MembersService(deps.members, deps.now, confirm);
  // 供其他模块调用 createInboxItem()
  app.decorate("inbox", inbox);
  registerInboxRoutes(app, inbox);
  // 入职流程（PRODUCT §9.1）：加 Key → 候选 → 一键入职
  const candidates = new CandidateFlow(
    members,
    deps.members,
    inbox,
    litellm,
    deps.now,
  );
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
  const usage = new UsageService(deps.settings, deps.now);
  registerMemberRoutes(
    app,
    members,
    {
      onboard: (id, audit) => candidates.onboard(id, audit),
      afterCreate: async (m) => {
        await refreshModelCaps(deps.members, litellm, deps.now, [m.name]).catch(
          () => 0,
        );
        return (await deps.members.get(m.id)) ?? m;
      },
    },
    membersForUser,
    async (scope) =>
      (await deps.keys.list(scope === "owner" ? undefined : scope))
        .filter((k) => k.status === "active")
        .map((k) => k.modelName),
    // Poke §5 成员状态：本账号在跑的助手步骤 + 今天的用量计数（账号用户的用量不分开记 → counters 为 null）
    async (scope) => {
      const working = new Map((await deps.assistants.workingMembers(scope)).map((w) => [w.memberId, w.since] as const));
      if (scope !== "owner") return { working, counters: null, limits: {} };
      const t = await usage.today();
      return { working, counters: t.counters, limits: t.limits };
    },
    deps.now,
  );
  const lead = new LeadService(deps.settings, deps.members, deps.now);
  const security = new SecurityService(deps.settings, deps.now);
  const userLeads = new Map<string, LeadService>();
  const leadForUser = (userId: string): LeadService => {
    let svc = userLeads.get(userId);
    if (!svc) {
      svc = new LeadService(
        scopedSettings(deps.settings, userId),
        deps.members.forUser(userId),
        deps.now,
      );
      userLeads.set(userId, svc);
    }
    return svc;
  };
  registerSettingsRoutes(app, lead, security, leadForUser);
  registerUsageRoutes(app, usage, (u) => (u === "owner" ? deps.members : deps.members.forUser(u)));
  // 对话入口（提议 H5）：LobeHub → Core /v1（D31 点名 / 交给负责人）→ LiteLLM
  const chatService = new ChatService({
    litellmBaseUrl: cfg.litellmBaseUrl,
    litellmKey: cfg.litellmMasterKey,
    listMembers: () => deps.members.listAll(),
    lead,
    security,
    // 规矩 = 所有者公共记忆的 rules 主题（B6）；没有就不注入
    rules: async () => (await deps.pubmem.get('owner', 'rules'))?.body ?? null,
    onCall: (m, o) => usage.record(m, o),
    onTokens: (m, n) => usage.recordTokens(m, n),
    ...(deps.chatFetch ? { fetchImpl: deps.chatFetch } : {}),
  });
  // 账号走自己的客户端令牌（models:chat）：成员 / 负责人 / 规矩 / 上游前缀都是它自己的，看不到所有者的任何东西
  const chatRouting: ChatUserRouting = {
    verify: async (token) => {
      const p = await clients.verify(token);
      // #376 M4：带执行员范围的（已签发的混合）令牌不认，失败即关闭
      return p && p.scopes.has("models:chat") && !hasExecutorScope(p.scopes) ? p.userId : null;
    },
    ctxFor: (userId) => ({
      upstreamModel: upstreamNameFor(userId),
      listMembers: () => deps.members.forUser(userId).listAll(),
      lead: leadForUser(userId),
      rules: async () => (await deps.pubmem.get(userId, "rules"))?.body ?? null,
      security: undefined,
      onCall: undefined,
      onTokens: undefined,
    }),
  };
  registerChatRoutes(app, chatService, cfg.chatToken, chatRouting);
  // 助手（指南 v1.1 附录 C）：第一版只给所有者；运行走同一个 ChatService（账号走自己的 ctxFor），整次运行在建它的账号的数据范围里
  const membersOf = (u: string) => (u === "owner" ? deps.members : deps.members.forUser(u));
  const assistantSvc = new AssistantService({ store: deps.assistants, membersFor: membersOf, confirm, now: deps.now, timezone: cfg.timezone });
  const assistantRunner = new AssistantRunner({
    store: deps.assistants,
    service: assistantSvc,
    membersFor: membersOf,
    chatFor: (u) => (req, signal) => chatService.complete(req, signal, u === "owner" ? undefined : chatRouting.ctxFor(u)),
    inbox,
    audit: bindAudit(deps.auditLog, { type: "system", id: "assistants" }),
    now: deps.now,
    timezone: cfg.timezone,
    // 成员名 = Key 的对外名；免费与否按 Key 的真实模型串判断（账号只看自己的 Key）
    deploymentsFor: async (u) => (await deps.keys.list(u === "owner" ? undefined : u)).map((k) => ({ modelName: k.modelName, model: k.model })),
    ...(deps.assistantTimeoutMs ? { timeoutMs: deps.assistantTimeoutMs } : {}),
    ...(deps.assistantIsFree ? { isFree: deps.assistantIsFree } : {}),
    ...(deps.assistantBudgets ? { budgets: deps.assistantBudgets } : {}),
  });
  assistantSvc.setLauncher(assistantRunner);
  // 控制台原生对话（#250 spike）：控制台会话 Cookie + CSRF 头 → 同一个 ChatService 和 ctxFor（D31 路由 / 署名不变）
  // X-15：所有者说「每周一 9 点帮我…」→ 负责人回助手草稿卡（规则判断、不调模型；没有负责人或校验不过就照常对话）
  const draftFor = async (text: string) => {
    const intent = detectAssistantIntent(text);
    if (!intent) return null;
    const leadId = (await lead.get()).effectiveLeadId;
    const leadMember = leadId ? await deps.members.get(leadId) : null;
    if (!leadId || !leadMember) return null;
    const r = await assistantSvc.preview("owner", { ...intent, members: [leadId], leadMemberId: leadId, budgetLevel: "low" });
    return { lead: leadMember.name, part: r.part };
  };
  const conversationSvc = new ConversationService({ store: deps.conversations, now: deps.now });
  registerConversationRoutes(app, conversationSvc);
  // X-19：长会话自动压缩，只用本账号的免费成员（同助手的免费判断），每天次数按低额度档。COMPACT_ENABLED=true 才建（默认关）
  const compactor = cfg.compactEnabled ? new Compactor({
    store: deps.conversations,
    summarize: freeSummarizer({
      membersFor: membersOf,
      deploymentsFor: async (u) => (await deps.keys.list(u === "owner" ? undefined : u)).map((k) => ({ modelName: k.modelName, model: k.model })),
      chatFor: (u) => (req, signal) => chatService.complete(req, signal, u === "owner" ? undefined : chatRouting.ctxFor(u)),
      ...(deps.assistantIsFree ? { isFree: deps.assistantIsFree } : {}),
    }),
    now: deps.now,
    timezone: cfg.timezone,
    ...(deps.compactLimits ? { limits: deps.compactLimits } : {}),
    warn: (event) => app.log.warn(event),
  }) : undefined;
  registerChatStreamRoute(app, chatService, { ctxFor: chatRouting.ctxFor, draftFor, conversations: conversationSvc, ...(compactor ? { compactor } : {}), ...(deps.chatStreamLimits ? { limits: deps.chatStreamLimits } : {}) });
  // 付费调用确认卡（kind=payment，重要确认）：同意 → 同一条运行继续；拒绝 → 取消
  inbox.registerHandler("assistant.run.confirm", async (item, actionId, audit) => {
    if (item.related?.type !== "assistant_run") return;
    await assistantRunner.resolveConfirmation(item.userId ?? "owner", item.related.id, actionId === "approve", audit);
  });
  registerAssistantRoutes(app, assistantSvc);
  app.decorate("assistants", { service: assistantSvc, runner: assistantRunner });
  // X-21：上次进程留下的 queued / running → failed/server_restart
  app.addHook("onReady", async () => {
    await assistantRunner.recoverAfterRestart().catch((err: Error) => app.log.error({ errName: err.name }, "assistant recovery failed"));
  });
  // 关闭时不等运行跑完：停掉进程内的运行，状态留给下次启动的恢复处理
  app.addHook("onClose", async () => assistantRunner.shutdown());

  // 账号的 Key 才跳过所有者的成员联动；所有者的行在 PG 上可能是 user_id='owner'（0024 回填），显式排除（#244 必改 2）
  const isAccountKey = (rec: { userId?: string }): boolean =>
    rec.userId !== undefined && rec.userId !== "" && rec.userId !== "owner";
  registerKeyRoutes(
    app,
    new KeysService(deps.keys, litellm, deps.now, confirm, {
      // 新 Key 的模型先进候选（名字 = LiteLLM 里对外的模型名），收件箱发「入职」卡片；同名成员已存在则只刷新模型事实
      // 入职候选 / 成员联动目前只服务所有者；账号的 Key 带前缀，成员由账号自己在「成员」里手动添加
      afterCreate: async (rec, audit) => {
        if (isAccountKey(rec)) return;
        await candidates.propose(rec.modelName, audit);
      },
      afterReplace: async (rec) => {
        if (isAccountKey(rec)) return;
        await refreshModelCaps(deps.members, litellm, deps.now, [
          rec.modelName,
        ]);
      },
      // 这个模型已经没有任何 Key：停用对应成员（可以在成员页重新启用）
      afterDelete: async (rec, audit) => {
        if (isAccountKey(rec)) return;
        const same = (n: string) =>
          n.toLowerCase() === rec.modelName.toLowerCase();
        if ((await deps.keys.list()).some((k) => same(k.modelName))) return;
        const m = (await members.list()).find((x) => same(x.name) && x.enabled);
        if (m) await members.update(m.id, { enabled: false }, audit);
      },
    }),
  );

  // 定时任务（回收站 30 天、过期确认清理、Key 对账）
  const jobs = new Scheduler(
    bindAudit(deps.auditLog, { type: "system", id: "jobs" }),
  );
  jobs.add(
    recycleBinJob(async () => [
      members,
      ...(await deps.members.userIds())
        .filter((u) => u !== "owner")
        .map(membersForUser),
    ]),
  );
  jobs.add(confirmCleanupJob(deps.confirmChallenges, deps.now));
  jobs.add(keyReconcileJob(deps.keys, litellm, inbox, deps.now));
  jobs.add(modelCapsJob(deps.members, litellm, deps.now));
  jobs.add(taskTimeoutJob(deps.executor, deps.now));
  jobs.add(quietTakeoverExpiryJob(inbox, executorSvc, deps.now));
  // 快跑阶段只有所有者：试用到期提醒只看所有者的设置（加固阶段再按用户遍历）
  jobs.add(trialExpiryJob(new TrialService(deps.settings, deps.now), inbox));
  // 助手定时执行器：默认关（ASSISTANT_SCHEDULER_ENABLED=true 才注册；阶段 3 才开）
  if (cfg.assistantSchedulerEnabled) {
    jobs.add(assistantSchedulerJob({ store: deps.assistants, start: (u, r) => assistantRunner.start(u, r), now: deps.now }));
  }
  // 裁定 12：等确认超过 24 小时自动作废（立即运行也会停在等确认，所以不受执行器总开关影响）
  jobs.add(confirmExpiryJob(() => assistantRunner.expireStaleConfirmations()));
  jobs.add(inboxTidyJob(inbox, deps.now, async () => (await deps.users.listUsers()).map((u) => u.id)));
  app.decorate("jobs", jobs);
  if (opts.startJobs ?? cfg.jobs) {
    app.addHook("onReady", async () => jobs.start());
  }
  app.addHook("onClose", async () => jobs.stop());

  return app;
}
