import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { type CoreDeps, memoryDeps, pgDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { OWNER_TOKEN, dbTargets, fakeClock, ownerAuth } from "./helpers/db.js";

const VAULT_KEY = randomBytes(32).toString("base64");
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
        VAULT_KEY,
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

  it("取凭据：只能取声明过的、持有租约的、本人保险箱里的；需要 tasks:secret", async () => {
    const { register, client } = await setup();
    const alice = await register("a2@example.com");
    const bob = await register("b2@example.com");
    const mk = async (h: typeof alice, v: string) =>
      (
        await h("POST", "/api/vault", { name: "n", kind: "password", value: v })
      ).json().secret.id as string;
    const sA = await mk(alice, "pw-alice-123");
    const sB = await mk(bob, "pw-bob-456");
    const devA = await client(alice, ["tasks:pull", "tasks:secret"]);
    const devNo = await client(alice, ["tasks:pull"]);
    for (const d of [devA, devNo])
      await d("POST", "/api/executor/hello", {
        deviceName: "pc",
        platform: "x",
        version: "1",
      });
    const tid = (
      await alice("POST", "/api/tasks", {
        kind: "login",
        site: "https://example.com/",
        secrets: [{ secretId: sA, field: "password" }],
      })
    ).json().task.id as string;
    const url = `/api/executor/tasks/${tid}/secret`;
    expect(
      (await devA("POST", url, { secretId: sA, field: "password" })).statusCode,
    ).toBe(409); // 未领取
    await devA("POST", "/api/executor/tasks/claim", { waitSec: 0 });
    const ok = await devA("POST", url, { secretId: sA, field: "password" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().value).toBe("pw-alice-123");
    expect(
      (await devA("POST", url, { secretId: sB, field: "password" })).statusCode,
    ).toBe(422);
    expect(
      (await devNo("POST", url, { secretId: sA, field: "password" }))
        .statusCode,
    ).toBe(403);
    const bobDev = await client(bob, ["tasks:pull", "tasks:secret"]);
    await bobDev("POST", "/api/executor/hello", {
      deviceName: "pc",
      platform: "x",
      version: "1",
    });
    expect(
      (await bobDev("POST", url, { secretId: sA, field: "password" }))
        .statusCode,
    ).toBe(404);
  });
});

describe.each(envs)("接管卡（$name）", (env) => {
  it("推卡 → 等待 → 所有者处理 → 不能越权", async () => {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: "silent",
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_ACCESS_REAUTH: "off",
        VAULT_KEY,
      }),
      deps,
    );
    try {
      const call =
        (headers: Record<string, string>) =>
        (method: "GET" | "POST", url: string, payload?: object) =>
          app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      const owner = call(ownerAuth);
      const tok = (
        await owner("POST", "/api/clients", {
          name: "c",
          scopes: ["tasks:pull"],
        })
      ).json().token as string;
      const dev = call({ authorization: `Bearer ${tok}` });
      await dev("POST", "/api/executor/hello", {
        deviceName: "pc",
        platform: "win32",
        version: "0.1.0",
      });
      const id = (
        await owner("POST", "/api/tasks", {
          kind: "login",
          site: "https://example.com/",
        })
      ).json().task.id as string;
      await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 });
      const tk = await dev("POST", `/api/executor/tasks/${id}/takeover`, {
        reason: "captcha",
        message: "请完成验证码",
      });
      expect(tk.statusCode).toBe(201);
      const tid = tk.json().takeoverId as string;
      const base = `/api/executor/tasks/${id}/takeover/${tid}`;
      expect((await dev("GET", base)).json().status).toBe("pending");
      expect(
        (await owner("GET", `/api/tasks/${id}/takeovers`)).json().takeovers,
      ).toHaveLength(1);
      expect(
        (
          await owner("POST", `/api/tasks/${id}/takeovers/${tid}/resolve`, {
            note: "done",
          })
        ).json().status,
      ).toBe("resolved");
      expect(
        (await owner("POST", `/api/tasks/${id}/takeovers/${tid}/resolve`, {}))
          .statusCode,
      ).toBe(409);
      expect((await dev("GET", base)).json()).toEqual({
        status: "resolved",
        note: "done",
      });
      expect(
        (await dev("GET", `/api/executor/tasks/${id}/takeover/${id}`))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
