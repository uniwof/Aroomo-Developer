import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { memoryDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { OWNER_TOKEN, fakeClock, ownerAuth } from "./helpers/db.js";

describe("接管卡进收件箱", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: "silent",
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_ACCESS_REAUTH: "off",
        VAULT_KEY: randomBytes(32).toString("base64"),
      }),
      memoryDeps(fakeClock().now),
    );
    apps.push(app);
    const call =
      (headers: Record<string, string>) =>
      (method: "GET" | "POST", url: string, payload?: object) =>
        app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const tok = (await owner("POST", "/api/clients", { name: "c", scopes: ["tasks:pull"] })).json().token as string;
    const dev = call({ authorization: `Bearer ${tok}` });
    await dev("POST", "/api/executor/hello", { deviceName: "pc", platform: "win32", version: "0.1.0" });
    const id = (await owner("POST", "/api/tasks", { kind: "login", site: "https://example.com/" })).json().task.id as string;
    await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 });
    const tid = (
      await dev("POST", `/api/executor/tasks/${id}/takeover`, { reason: "captcha", message: "请完成验证码" })
    ).json().takeoverId as string;
    const open = async () =>
      ((await owner("GET", "/api/inbox?group=decision&status=open")).json().items as Array<{ id: string; kind: string; group: string; urgency: string; title: string; actions: Array<{ id: string }> }>).filter(
        (i) => i.kind === "executor.takeover",
      );
    return { owner, dev, id, tid, open };
  }

  it("推接管卡 → 收件箱出现紧急卡，不含凭据；按「我处理好了」→ 接管卡 resolved，执行员收到", async () => {
    const { owner, dev, id, tid, open } = await setup();
    const cards = await open();
    expect(cards).toHaveLength(1);
    expect(cards[0].group).toBe("decision");
    expect(cards[0].urgency).toBe("urgent");
    expect(cards[0].title).toContain("example.com");
    expect(cards[0].actions.map((a) => a.id)).toEqual(["done", "cancel"]);
    const r = await owner("POST", `/api/inbox/${cards[0].id}/actions/done`, {});
    expect(r.statusCode).toBe(200);
    expect((await dev("GET", `/api/executor/tasks/${id}/takeover/${tid}`)).json().status).toBe("resolved");
    expect(await open()).toHaveLength(0);
  });

  it("卡上点「取消这个任务」→ 接管卡 cancelled", async () => {
    const { owner, dev, id, tid, open } = await setup();
    const [card] = await open();
    expect((await owner("POST", `/api/inbox/${card.id}/actions/cancel`, {})).statusCode).toBe(200);
    expect((await dev("GET", `/api/executor/tasks/${id}/takeover/${tid}`)).json().status).toBe("cancelled");
  });

  it("在任务页处理后，收件箱的卡自动收掉", async () => {
    const { owner, id, tid, open } = await setup();
    expect(await open()).toHaveLength(1);
    expect((await owner("POST", `/api/tasks/${id}/takeovers/${tid}/resolve`, { note: "ok" })).statusCode).toBe(200);
    expect(await open()).toHaveLength(0);
  });
});
