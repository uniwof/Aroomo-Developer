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

describe.each(envs)("服务器端站点白名单（$name）", (env) => {
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

  it("白名单：空=不限；设置后只放行命中的域名（含子域名）和包名；不同账号互不影响", async () => {
    const { owner, register } = await setup();
    const t = (h: typeof owner, site: string) =>
      h("POST", "/api/tasks", { kind: "browse", site });
    expect((await t(owner, "https://anything.org/")).statusCode).toBe(201);
    const put = await owner("PUT", "/api/executor-allowlist", {
      sites: ["Example.com", "https://login.foo.net/path", "example.com", "android-app://com.a.b"],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().sites).toEqual(["example.com", "login.foo.net", "android-app://com.a.b"]);
    expect((await owner("GET", "/api/executor-allowlist")).json().sites).toHaveLength(3);
    expect((await t(owner, "https://www.example.com/x")).statusCode).toBe(201);
    expect((await t(owner, "https://example.com.evil.org/")).statusCode).toBe(403);
    expect((await t(owner, "https://notexample.com/")).statusCode).toBe(403);
    expect((await t(owner, "https://foo.net/")).statusCode).toBe(403);
    expect((await t(owner, "android-app://com.a.b")).statusCode).toBe(201);
    const bad = await t(owner, "android-app://com.other");
    expect(bad.statusCode).toBe(403);
    expect(bad.json().code ?? bad.json().error?.code).toBe("SITE_NOT_ALLOWED");
    // 别的账号不受影响，也看不到我的名单
    const bob = await register("b@example.com");
    expect((await t(bob, "https://anything.org/")).statusCode).toBe(201);
    expect((await bob("GET", "/api/executor-allowlist")).json().sites).toEqual([]);
    // 清空 = 不限制
    await owner("PUT", "/api/executor-allowlist", { sites: [] });
    expect((await t(owner, "https://anything.org/")).statusCode).toBe(201);
  });

  it("白名单：非法条目拒绝；设备令牌不能改名单；hello 的 allowlistHash 出现在 /api/executors", async () => {
    const { owner, client } = await setup();
    expect((await owner("PUT", "/api/executor-allowlist", { sites: ["not a host"] })).statusCode).toBe(400);
    expect((await owner("PUT", "/api/executor-allowlist", { sites: ["localhost"] })).statusCode).toBe(400);
    const dev = await client(owner, ["tasks:pull"]);
    expect((await dev("PUT", "/api/executor-allowlist", { sites: ["a.com"] })).statusCode).toBe(403);
    expect((await dev("GET", "/api/executor-allowlist")).statusCode).toBe(403);
    await dev("POST", "/api/executor/hello", { deviceName: "pc", platform: "x", version: "1", allowlistHash: "abc123" });
    const ex = (await owner("GET", "/api/executors")).json().executors;
    expect(ex[0].allowlistHash).toBe("abc123");
  });
});
