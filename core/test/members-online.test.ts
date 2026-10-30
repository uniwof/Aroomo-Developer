import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { memoryDeps } from "../src/deps.js";
import { isOnline } from "../src/members/routes.js";
import type { Member } from "../src/members/types.js";
import { buildServer } from "../src/server.js";
import { OWNER_TOKEN, fakeClock, ownerAuth } from "./helpers/db.js";

describe("成员在线 online（有一把正常的 Key 对着它）", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  it("isOnline：在职 + 启用 + 未删除 + 有正常 Key（名字不分大小写）", () => {
    const m = { name: "Claude", status: "active", enabled: true, deletedAt: null } as Member;
    const keys = new Set(["claude"]);
    expect(isOnline(m, keys)).toBe(true);
    expect(isOnline({ ...m, enabled: false }, keys)).toBe(false);
    expect(isOnline({ ...m, status: "candidate" }, keys)).toBe(false);
    expect(isOnline({ ...m, deletedAt: new Date() }, keys)).toBe(false);
    expect(isOnline(m, new Set())).toBe(false);
  });

  it("GET /api/members 带 online：没 Key 离线，有正常 Key 在线，Key 同步失败又离线", async () => {
    const deps = memoryDeps(fakeClock().now);
    const app = buildServer(
      loadConfig({ CORE_LOG_LEVEL: "silent", CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: "off", VAULT_KEY: randomBytes(32).toString("base64") }),
      deps,
    );
    apps.push(app);
    const get = async () => (await app.inject({ method: "GET", url: "/api/members", headers: ownerAuth })).json().members as Array<{ name: string; online: boolean }>;
    await app.inject({ method: "POST", url: "/api/members", headers: ownerAuth, payload: { name: "Claude" } });
    expect((await get())[0]!.online).toBe(false);
    const now = new Date();
    const rec = {
      id: "k1", name: "k", sourceUrl: "https://x.example", last4: "abcd", model: "anthropic/claude", modelName: "Claude", apiBase: null,
      litellmModelId: "m1", status: "active" as const, modelsSyncedAt: null, createdAt: now, updatedAt: now,
    };
    await deps.keys.insert(rec);
    expect((await get())[0]!.online).toBe(true);
    await deps.keys.update({ ...rec, status: "sync_failed" });
    expect((await get())[0]!.online).toBe(false);
  });
});
