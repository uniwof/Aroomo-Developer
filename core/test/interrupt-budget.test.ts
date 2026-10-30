import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { memoryDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { OWNER_TOKEN, fakeClock, ownerAuth } from "./helpers/db.js";

type Card = { id: string; kind: string; urgency: string; summary: string };

describe("打扰预算（D100）", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const clock = fakeClock();
    const app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: "silent",
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_ACCESS_REAUTH: "off",
        VAULT_KEY: randomBytes(32).toString("base64"),
      }),
      memoryDeps(clock.now),
    );
    apps.push(app);
    const call =
      (headers: Record<string, string>) =>
      (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
        app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const tok = (await owner("POST", "/api/clients", { name: "c", scopes: ["tasks:pull"] })).json().token as string;
    const dev = call({ authorization: `Bearer ${tok}` });
    await dev("POST", "/api/executor/hello", { deviceName: "pc", platform: "win32", version: "0.1.0" });
    /** 新建任务 → 领取 → 推接管卡 */
    const takeover = async (reason: string) => {
      const id = (await owner("POST", "/api/tasks", { kind: "login", site: "https://example.com/" })).json().task.id as string;
      const claimed = (await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 })).json();
      expect(claimed.task?.id).toBe(id);
      const tid = (await dev("POST", `/api/executor/tasks/${id}/takeover`, { reason, message: "请处理" })).json().takeoverId as string;
      return { id, tid };
    };
    /** 处理好接管并让任务做完，执行员才能领下一个 */
    const finish = async (t: { id: string; tid: string }) => {
      await owner("POST", `/api/tasks/${t.id}/takeovers/${t.tid}/resolve`, {});
      await dev("POST", `/api/executor/tasks/${t.id}/result`, { status: "succeeded", summary: "ok" });
    };
    const cards = async () =>
      ((await owner("GET", "/api/inbox?group=decision&status=open")).json().items as Card[]).filter((i) => i.kind === "executor.takeover");
    return { app, clock, owner, dev, takeover, finish, cards };
  }

  it("默认每天 3 张：前 3 张紧急，第 4 张降为普通；次日重新计数", async () => {
    const { clock, owner, takeover, finish, cards } = await setup();
    expect((await owner("GET", "/api/interrupt-budget")).json()).toEqual({ daily: 3 });
    for (let i = 0; i < 3; i++) {
      const { id, tid } = await takeover("captcha");
      expect((await cards()).every((c) => c.urgency === "urgent")).toBe(true);
      await finish({ id, tid });
    }
    const t4 = await takeover("captcha");
    const c4 = await cards();
    expect(c4).toHaveLength(1);
    expect(c4[0]?.urgency).toBe("normal");
    expect(c4[0]?.summary).toContain("30 分钟");
    await finish(t4);
    clock.advance(24 * 60 * 60 * 1000);
    await takeover("captcha");
    expect((await cards())[0]?.urgency).toBe("urgent");
  });

  it("预算可调；付款类永远是紧急卡", async () => {
    const { owner, takeover, cards } = await setup();
    expect((await owner("PUT", "/api/interrupt-budget", { daily: 0 })).json()).toEqual({ daily: 0 });
    expect((await owner("PUT", "/api/interrupt-budget", { daily: -1 })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner("PUT", "/api/interrupt-budget", { daily: 99 })).statusCode).toBe(400);
    await takeover("payment");
    expect((await cards())[0]?.urgency).toBe("urgent");
  });

  it("超预算的卡 30 分钟没人处理 → 任务自动取消；紧急卡与付款卡不动", async () => {
    const { app, clock, owner, takeover, finish, cards } = await setup();
    await owner("PUT", "/api/interrupt-budget", { daily: 1 });
    const loud = await takeover("captcha");
    // 第二张超预算：先让第一张的任务做完，执行员才能领下一个
    await finish(loud);
    const quiet = await takeover("2fa");
    expect((await cards())[0]?.urgency).toBe("normal");
    clock.advance(29 * 60 * 1000);
    await app.jobs.runOnce("takeover-quiet-expiry");
    expect(await cards()).toHaveLength(1);
    clock.advance(2 * 60 * 1000);
    expect(await app.jobs.runOnce("takeover-quiet-expiry")).toBe("cancelled=1");
    expect(await cards()).toHaveLength(0);
    const list = (await owner("GET", `/api/tasks/${quiet.id}/takeovers`)).json().takeovers as Array<{ id: string; status: string }>;
    expect(list.find((x) => x.id === quiet.tid)?.status).toBe("cancelled");
  });
});
