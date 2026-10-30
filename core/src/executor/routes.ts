/**
 * 执行员 ↔ Core（docs/executor-protocol.md）：/api/executor/*（设备令牌，scope tasks:pull）
 * 与人用的 /api/tasks、/api/executors（所有者 / 账号）。所有读写都按令牌归属的 user_id。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { scopeOf } from "../auth/plugin.js";
import { HttpError } from "../http/errors.js";
import { ExecutorService, taskJson } from "./service.js";

const uuidParam = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export function registerExecutorRoutes(
  app: FastifyInstance,
  svc: ExecutorService,
): void {
  const dev = { config: { clientScope: "tasks:pull" } };
  const who = (req: FastifyRequest) => {
    const p = req.principal;
    if (!p || p.type !== "client")
      throw new HttpError(403, "FORBIDDEN", "只有设备令牌可以调用");
    return { userId: p.userId, clientId: p.clientId };
  };
  const human = {
    config: { userRoute: true as const },
    preHandler: async (req: FastifyRequest) => {
      const p = req.principal;
      if (!p || (p.type !== "owner" && p.type !== "user"))
        throw new HttpError(403, "FORBIDDEN", "只有本人登录后可以管理任务");
    },
  };

  app.post<{
    Body: {
      deviceName: string;
      platform: string;
      version: string;
      adapters?: string[];
      allowlistHash?: string;
    };
  }>(
    "/api/executor/hello",
    {
      ...dev,
      schema: {
        body: {
          type: "object",
          required: ["deviceName", "platform", "version"],
          properties: {
            deviceName: { type: "string", maxLength: 64 },
            platform: { type: "string", maxLength: 32 },
            version: { type: "string", maxLength: 32 },
            adapters: {
              type: "array",
              maxItems: 10,
              items: { type: "string", maxLength: 32 },
            },
            allowlistHash: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (req) => {
      const w = who(req);
      return svc.hello(w.userId, w.clientId, req.body, req.audit);
    },
  );

  app.post<{ Body: { waitSec?: number; kinds?: string[] } }>(
    "/api/executor/tasks/claim",
    {
      ...dev,
      schema: {
        body: {
          type: ["object", "null"],
          properties: {
            waitSec: { type: "integer", minimum: 0, maximum: 30 },
            kinds: {
              type: "array",
              maxItems: 4,
              items: { type: "string", maxLength: 16 },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const w = who(req);
      const t = await svc.claim(
        w.userId,
        w.clientId,
        req.body?.waitSec ?? 0,
        req.body?.kinds ?? null,
        req.audit,
      );
      if (!t) return reply.status(204).send();
      return { task: { ...taskJson(t) } };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { seq?: number; stage: string; message: string };
  }>(
    "/api/executor/tasks/:id/progress",
    {
      ...dev,
      schema: {
        params: uuidParam,
        body: {
          type: "object",
          required: ["stage", "message"],
          properties: {
            seq: { type: "integer" },
            stage: { type: "string", maxLength: 64 },
            message: { type: "string", maxLength: 500 },
            screenshot: { type: "object" },
          },
        },
      },
    },
    async (req) => {
      const w = who(req);
      return svc.progress(w.userId, w.clientId, req.params.id, req.body);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      status: "succeeded" | "failed" | "cancelled";
      summary: string;
      error?: string;
    };
  }>(
    "/api/executor/tasks/:id/result",
    {
      ...dev,
      schema: {
        params: uuidParam,
        body: {
          type: "object",
          required: ["status", "summary"],
          properties: {
            status: { enum: ["succeeded", "failed", "cancelled"] },
            summary: { type: "string", maxLength: 2000 },
            error: { type: "string", maxLength: 1000 },
            screenshot: { type: "object" },
          },
        },
      },
    },
    async (req) => {
      const w = who(req);
      await svc.result(
        w.userId,
        w.clientId,
        req.params.id,
        req.body,
        req.audit,
      );
      return {};
    },
  );

  app.post<{
    Params: { id: string };
    Body: { secretId: string; field: string };
  }>(
    "/api/executor/tasks/:id/secret",
    {
      config: { clientScope: "tasks:secret" },
      schema: {
        params: uuidParam,
        body: {
          type: "object",
          required: ["secretId", "field"],
          additionalProperties: false,
          properties: {
            secretId: { type: "string", format: "uuid" },
            field: { type: "string", maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const w = who(req);
      reply.header("cache-control", "no-store");
      return svc.secret(
        w.userId,
        w.clientId,
        req.params.id,
        req.body,
        req.audit,
      );
    },
  );

  const idTid = {
    type: "object",
    required: ["id", "tid"],
    properties: {
      id: { type: "string", format: "uuid" },
      tid: { type: "string", format: "uuid" },
    },
  } as const;
  app.post<{
    Params: { id: string };
    Body: { reason: string; message: string };
  }>(
    "/api/executor/tasks/:id/takeover",
    {
      ...dev,
      schema: {
        params: uuidParam,
        body: {
          type: "object",
          required: ["reason", "message"],
          properties: {
            reason: { type: "string", maxLength: 200 },
            message: { type: "string", maxLength: 1000 },
            screenshot: { type: "object" },
          },
        },
      },
    },
    async (req, reply) => {
      const w = who(req);
      return reply
        .status(201)
        .send(
          await svc.takeover(
            w.userId,
            w.clientId,
            req.params.id,
            req.body,
            req.audit,
          ),
        );
    },
  );
  app.get<{
    Params: { id: string; tid: string };
    Querystring: { waitSec?: number };
  }>(
    "/api/executor/tasks/:id/takeover/:tid",
    {
      ...dev,
      schema: {
        params: idTid,
        querystring: {
          type: "object",
          properties: {
            waitSec: { type: "integer", minimum: 0, maximum: 30 },
          },
        },
      },
    },
    async (req) => {
      const w = who(req);
      return svc.takeoverStatus(
        w.userId,
        w.clientId,
        req.params.id,
        req.params.tid,
        req.query.waitSec ?? 0,
      );
    },
  );

  // —— 人用 ——
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/takeovers",
    { ...human, schema: { params: uuidParam } },
    async (req) => ({
      takeovers: await svc.takeovers(scopeOf(req), req.params.id),
    }),
  );
  app.post<{
    Params: { id: string; tid: string };
    Body: { cancel?: boolean; note?: string } | null;
  }>(
    "/api/tasks/:id/takeovers/:tid/resolve",
    {
      ...human,
      schema: {
        params: idTid,
        body: {
          type: ["object", "null"],
          properties: {
            cancel: { type: "boolean" },
            note: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (req) =>
      svc.resolveTakeover(
        scopeOf(req),
        req.params.id,
        req.params.tid,
        req.body ?? {},
        req.audit,
      ),
  );

  app.post<{
    Body: {
      kind: string;
      site: string;
      instruction?: string;
      secrets?: { secretId: string; field: string }[];
      options?: Record<string, unknown>;
    };
  }>(
    "/api/tasks",
    {
      ...human,
      schema: {
        body: {
          type: "object",
          required: ["kind", "site"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", maxLength: 16 },
            site: { type: "string", maxLength: 2048 },
            instruction: { type: "string", maxLength: 4000 },
            secrets: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                required: ["secretId", "field"],
                additionalProperties: false,
                properties: {
                  secretId: { type: "string", format: "uuid" },
                  field: { type: "string", maxLength: 64 },
                },
              },
            },
            options: { type: "object" },
          },
        },
      },
    },
    async (req, reply) =>
      reply.status(201).send({
        task: taskJson(await svc.create(scopeOf(req), req.body, req.audit)),
      }),
  );
  app.get("/api/tasks", human, async (req) => ({
    tasks: (await svc.list(scopeOf(req))).map(taskJson),
  }));
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { ...human, schema: { params: uuidParam } },
    async (req) => ({
      task: taskJson(await svc.get(scopeOf(req), req.params.id)),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    { ...human, schema: { params: uuidParam } },
    async (req) => ({
      task: taskJson(await svc.cancel(scopeOf(req), req.params.id, req.audit)),
    }),
  );
  const allowBody = {
    schema: {
      body: {
        type: "object",
        required: ["sites"],
        additionalProperties: false,
        properties: {
          sites: { type: "array", maxItems: 100, items: { type: "string", maxLength: 300 } },
        },
      },
    },
  };
  app.get("/api/executor-allowlist", human, async (req) => ({
    sites: await svc.getAllowlist(scopeOf(req)),
  }));
  app.put<{ Body: { sites: string[] } }>(
    "/api/executor-allowlist",
    { ...human, ...allowBody },
    async (req) => ({
      sites: await svc.setAllowlist(scopeOf(req), req.body.sites, req.audit),
    }),
  );
  app.get("/api/executors", human, async (req) => ({
    executors: await svc.executors(scopeOf(req)),
  }));
}
