import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { memoryDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { dayKey, ringState } from "../src/usage/service.js";
import { OWNER_TOKEN, fakeClock, ownerAuth } from "./helpers/db.js";

const CHAT_TOKEN = "placeholder-chat-token-0123456789abcdefgh";

describe("额度圆环 /api/usage", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  function setup() {
    const clock = fakeClock();
    const status: Record<string, number> = {};
    const tokens: Record<string, number> = {};
    const deps = memoryDeps(clock.now);
    deps.chatFetch = (async (_url: unknown, init?: { body?: string }) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      const st = status[model] ?? 200;
      const total = tokens[model];
      return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], ...(total ? { usage: { total_tokens: total } } : {}) }), {
        status: st,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: "silent",
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_CHAT_TOKEN: CHAT_TOKEN,
        CORE_ACCESS_REAUTH: "off",
        LITELLM_BASE_URL: "http://litellm.invalid",
        LITELLM_MASTER_KEY: "placeholder-master-key-for-tests-0001",
        VAULT_KEY: randomBytes(32).toString("base64"),
      }),
      deps,
    );
    apps.push(app);
    const owner = (method: "GET" | "PUT" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: ownerAuth, ...(payload ? { payload } : {}) });
    const say = (model: string) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${CHAT_TOKEN}` },
        payload: { model, messages: [{ role: "user", content: "hi" }] },
      });
    return { app, owner, say, status, tokens, clock };
  }

  it("按成员数今天的调用；出错、被限流分开记；没填上限 = 未知", async () => {
    const t = setup();
    await t.owner("POST", "/api/members", { name: "Alpha" });
    await t.owner("POST", "/api/members", { name: "Beta" });
    await t.say("aroomo/alpha");
    await t.say("aroomo/alpha");
    t.status["Beta"] = 500;
    await t.say("aroomo/beta");
    const u = (await t.owner("GET", "/api/usage")).json();
    const row = (n: string) => u.members.find((m: { name: string }) => m.name === n);
    expect(u.tracked).toBe(true);
    expect(row("Alpha").today).toEqual({ requests: 2, errors: 0, limited: 0 });
    expect(row("Alpha").quotaKnown).toBe(false);
    expect(row("Alpha").ratio).toBeNull();
    expect(row("Alpha").state).toBe("unknown");
    expect(row("Beta").today).toEqual({ requests: 1, errors: 1, limited: 0 });
    expect(u.total).toEqual({ requests: 3, errors: 1, limited: 0 });
  });

  it("供应商返回了用量就累计 token；没返回的成员显示未知（null）", async () => {
    const t = setup();
    await t.owner("POST", "/api/members", { name: "Alpha" });
    await t.owner("POST", "/api/members", { name: "Beta" });
    t.tokens["Alpha"] = 120;
    await t.say("aroomo/alpha");
    await t.say("aroomo/alpha");
    await t.say("aroomo/beta");
    const u = (await t.owner("GET", "/api/usage")).json();
    const row = (n: string) => u.members.find((m: { name: string }) => m.name === n);
    expect(row("Alpha").tokensToday).toBe(240);
    expect(row("Beta").tokensToday).toBeNull();
    expect(row("Alpha").today).toEqual({ requests: 2, errors: 0, limited: 0 });
  });

  it("供应商返回 429：当天标 limited", async () => {
    const t = setup();
    await t.owner("POST", "/api/members", { name: "Alpha" });
    t.status["Alpha"] = 429;
    await t.say("aroomo/alpha");
    const u = (await t.owner("GET", "/api/usage")).json();
    expect(u.members[0].today.limited).toBe(1);
    expect(u.members[0].state).toBe("limited");
  });

  it("填每天上限后给比例；PUT null 清除；非法值 400；没这位成员 404", async () => {
    const t = setup();
    const created = (await t.owner("POST", "/api/members", { name: "Alpha" })).json();
    const id = (created.member ?? created).id as string;
    await t.say("aroomo/alpha");
    await t.say("aroomo/alpha");
    await t.say("aroomo/alpha");
    await t.say("aroomo/alpha");
    expect((await t.owner("PUT", `/api/usage/limits/${id}`, { dailyLimit: 5 })).statusCode).toBe(200);
    let m = (await t.owner("GET", "/api/usage")).json().members[0];
    expect(m).toMatchObject({ quotaKnown: true, ratio: 0.8, state: "warn", quota: { used: 4, limit: 5, unit: "次/天" } });
    await t.say("aroomo/alpha");
    m = (await t.owner("GET", "/api/usage")).json().members[0];
    expect(m.state).toBe("full");
    expect((await t.owner("PUT", `/api/usage/limits/${id}`, { dailyLimit: 0 })).statusCode).toBe(400);
    expect((await t.owner("PUT", `/api/usage/limits/${id}`, { dailyLimit: 1.5 })).statusCode).toBe(400);
    expect((await t.owner("PUT", "/api/usage/limits/nope", { dailyLimit: 3 })).statusCode).toBe(404);
    await t.owner("PUT", `/api/usage/limits/${id}`, { dailyLimit: null });
    m = (await t.owner("GET", "/api/usage")).json().members[0];
    expect(m.quotaKnown).toBe(false);
  });

  it("第二天从零数起，近 7 天合计保留", async () => {
    const t = setup();
    await t.owner("POST", "/api/members", { name: "Alpha" });
    await t.say("aroomo/alpha");
    t.clock.advance(24 * 60 * 60 * 1000);
    const m = (await t.owner("GET", "/api/usage")).json().members[0];
    expect(m.today.requests).toBe(0);
    expect(m.last7DaysRequests).toBe(1);
  });

  it("没登录不能看", async () => {
    const t = setup();
    expect((await t.app.inject({ method: "GET", url: "/api/usage" })).statusCode).toBe(401);
  });

  it("日期键按北京时间；圆环状态", () => {
    expect(dayKey(new Date("2026-10-30T16:30:00Z"))).toBe("20261031");
    expect(dayKey(new Date("2026-10-30T15:30:00Z"))).toBe("20261030");
    expect(ringState({ requests: 0, errors: 0, limited: 0 }, null)).toBe("unknown");
    expect(ringState({ requests: 79, errors: 0, limited: 0 }, 100)).toBe("ok");
    expect(ringState({ requests: 80, errors: 0, limited: 0 }, 100)).toBe("warn");
    expect(ringState({ requests: 100, errors: 0, limited: 0 }, 100)).toBe("full");
  });
});

describe("悬停卡 /api/members/:id/card", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  it("只有三样；填了上限才有余量（估算），否则未知；不出站；小号看不到所有者成员", async () => {
    const clock = fakeClock();
    let outbound = 0;
    const deps = memoryDeps(clock.now);
    deps.chatFetch = (async () => {
      outbound += 1;
      return new Response("{}");
    }) as typeof fetch;
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: "silent", CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: "off" }), deps);
    apps.push(app);
    const call = (headers: Record<string, string>) => (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    await owner("POST", "/api/members", { name: "Alpha", capabilityTags: ["image"] });
    const before = outbound;
    let c = (await owner("GET", "/api/members/alpha/card")).json();
    expect(Object.keys(c).sort()).toEqual(["name", "remaining", "status", "type"]);
    expect(c).toMatchObject({ name: "Alpha", type: ["image"], status: "可用", remaining: { value: null, source: "未知" } });
    await owner("PUT", "/api/usage/limits/alpha", { dailyLimit: 10 });
    c = (await owner("GET", "/api/members/alpha/card")).json();
    expect(c.remaining).toEqual({ value: 10, unit: "次/天", source: "估算" });
    expect(JSON.stringify(c)).not.toMatch(/key|price|rate/i);
    expect(outbound).toBe(before);
    const inv = await owner("POST", "/api/users/invites", { email: "s@example.com" });
    const r = await app.inject({ method: "POST", url: "/auth/accept", payload: { token: inv.json().token, password: "correct-horse-battery" } });
    const small = call({ authorization: `Bearer ${r.json().token}` });
    expect((await small("GET", "/api/members/alpha/card")).statusCode).toBe(404);
  });
});
