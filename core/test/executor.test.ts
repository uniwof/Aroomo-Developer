import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { type CoreDeps, memoryDeps, pgDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from "./helpers/db.js";

const PW = "correct-horse-battery";
const envs = [
  {
    name: "memory",
    make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now),
  },
  ...dbTargets.map((t) => ({
    name: t.name,
    make: async (now: () => Date): Promise<CoreDeps> =>
      pgDeps(await t.open(), now),
  })),
];

describe.each(envs)("执行员任务队列（$name）", (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: "silent",
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_ACCESS_REAUTH: "off",
      }),
      deps,
    );
    apps.push(app);
    const call =
      (headers: Record<string, string>) =>
      (
        method: "GET" | "PUT" | "POST" | "DELETE",
        url: string,
        payload?: object,
      ) =>
        app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const bearer = (t: string) => call({ authorization: `Bearer ${t}` });
    const register = async (email: string) => {
      const inv = await owner("POST", "/api/users/invites", { email });
      const r = await app.inject({
        method: "POST",
        url: "/auth/accept",
        payload: { token: inv.json().token, password: PW },
      });
      return bearer(r.json().token);
    };
    const client = async (human: ReturnType<typeof call>, scopes: string[]) =>
      bearer(
        (await human("POST", "/api/clients", { name: "c", scopes })).json()
          .token,
      );
    return { owner, bearer, register, client, clock };
  }

  it("hello → 创建任务 → 领取只能一次 → 进度 → 结果幂等", async () => {
    const { owner, client } = await setup();
    const dev = await client(owner, ["tasks:pull"]);
    expect(
      (await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 }))
        .statusCode,
    ).toBe(409); // 未 hello
    const h = await dev("POST", "/api/executor/hello", {
      deviceName: "pc",
      platform: "win32",
      version: "0.1.0",
      adapters: ["ego-lite"],
    });
    expect(h.statusCode).toBe(200);
    expect(
      (
        await dev("POST", "/api/executor/hello", {
          deviceName: "pc",
          platform: "win32",
          version: "0.1.0",
        })
      ).json().executorId,
    ).toBe(h.json().executorId);
    expect(
      (await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 }))
        .statusCode,
    ).toBe(204);
    const c = await owner("POST", "/api/tasks", {
      kind: "checkin",
      site: "https://example.com/",
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().task.id as string;
    const got = await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 });
    expect(got.json().task.id).toBe(id);
    expect(
      (await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 }))
        .statusCode,
    ).toBe(204);
    const p = await dev("POST", `/api/executor/tasks/${id}/progress`, {
      stage: "open",
      message: "ok",
    });
    expect(p.json().cancel).toBe(false);
    const r1 = await dev("POST", `/api/executor/tasks/${id}/result`, {
      status: "succeeded",
      summary: "已签到",
    });
    expect(r1.statusCode).toBe(200);
    expect(
      (
        await dev("POST", `/api/executor/tasks/${id}/result`, {
          status: "succeeded",
          summary: "已签到",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await dev("POST", `/api/executor/tasks/${id}/result`, {
          status: "failed",
          summary: "x",
        })
      ).statusCode,
    ).toBe(409);
    expect((await owner("GET", `/api/tasks/${id}`)).json().task.status).toBe(
      "succeeded",
    );
    expect(
      (await owner("GET", "/api/executors")).json().executors[0].online,
    ).toBe(true);
  });

  it("租约过期退回队列，旧执行员 409 LEASE_LOST；所有者取消通过 progress 通知", async () => {
    const { owner, client, clock } = await setup();
    const a = await client(owner, ["tasks:pull"]);
    const b = await client(owner, ["tasks:pull"]);
    for (const d of [a, b])
      await d("POST", "/api/executor/hello", {
        deviceName: "pc",
        platform: "win32",
        version: "1",
      });
    const id = (
      await owner("POST", "/api/tasks", {
        kind: "login",
        site: "https://example.com/",
      })
    ).json().task.id as string;
    expect(
      (await a("POST", "/api/executor/tasks/claim", { waitSec: 0 })).json().task
        .id,
    ).toBe(id);
    clock.advance(601_000);
    expect(
      (await b("POST", "/api/executor/tasks/claim", { waitSec: 0 })).json().task
        .id,
    ).toBe(id);
    expect(
      (
        await a("POST", `/api/executor/tasks/${id}/progress`, {
          stage: "s",
          message: "m",
        })
      ).json().error.code,
    ).toBe("LEASE_LOST");
    await owner("POST", `/api/tasks/${id}/cancel`);
    expect(
      (
        await b("POST", `/api/executor/tasks/${id}/progress`, {
          stage: "s",
          message: "m",
        })
      ).json().cancel,
    ).toBe(true);
  });

  it("越权：别人的令牌领不到、看不到、取消不了我的任务；没有 tasks:pull 的客户端 403", async () => {
    const { owner, register, client } = await setup();
    const alice = await register("a@example.com");
    const bob = await register("b@example.com");
    const bobDev = await client(bob, ["tasks:pull"]);
    await bobDev("POST", "/api/executor/hello", {
      deviceName: "pc",
      platform: "x",
      version: "1",
    });
    const id = (
      await alice("POST", "/api/tasks", {
        kind: "browse",
        site: "https://example.com/",
      })
    ).json().task.id as string;
    expect(
      (await bobDev("POST", "/api/executor/tasks/claim", { waitSec: 0 }))
        .statusCode,
    ).toBe(204);
    expect((await bob("GET", `/api/tasks/${id}`)).statusCode).toBe(404);
    expect((await bob("POST", `/api/tasks/${id}/cancel`)).statusCode).toBe(404);
    expect((await bob("GET", "/api/tasks")).json().tasks).toHaveLength(0);
    expect((await bob("GET", "/api/executors")).json().executors).toHaveLength(
      1,
    );
    expect(
      (await alice("GET", "/api/executors")).json().executors,
    ).toHaveLength(0);
    expect(
      (
        await bobDev("POST", `/api/executor/tasks/${id}/result`, {
          status: "succeeded",
          summary: "x",
        })
      ).statusCode,
    ).toBe(404);
    const noScope = await client(alice, ["memory:read"]);
    expect(
      (
        await noScope("POST", "/api/executor/hello", {
          deviceName: "pc",
          platform: "x",
          version: "1",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await bobDev("POST", "/api/tasks", {
          kind: "browse",
          site: "https://example.com/",
        })
      ).statusCode,
    ).toBe(403);
    expect((await owner("GET", "/api/tasks")).json().tasks).toHaveLength(0);
  });

  it("参数校验：坏网址、坏类型", async () => {
    const { owner } = await setup();
    expect(
      (
        await owner("POST", "/api/tasks", {
          kind: "checkin",
          site: "javascript:alert(1)",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner("POST", "/api/tasks", {
          kind: "hack",
          site: "https://example.com/",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner("POST", "/api/tasks", {
          kind: "browse",
          site: "android-app://com.example.app",
        })
      ).statusCode,
    ).toBe(201);
  });
});
