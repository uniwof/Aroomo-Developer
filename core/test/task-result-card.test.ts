import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { memoryDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { OWNER_TOKEN, fakeClock, ownerAuth } from "./helpers/db.js";

describe("任务结果进收件箱", () => {
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
    const run = async (status: string, body: object) => {
      const id = (await owner("POST", "/api/tasks", { kind: "checkin", site: "https://example.com/" })).json().task.id as string;
      await dev("POST", "/api/executor/tasks/claim", { waitSec: 0 });
      expect((await dev("POST", `/api/executor/tasks/${id}/result`, { status, ...body })).statusCode).toBe(200);
      return id;
    };
    const cards = async () =>
      (
        (await owner("GET", "/api/inbox?group=brief&status=open")).json().items as Array<{
          id: string; kind: string; group: string; urgency: string; title: string; summary: string;
        }>
      ).filter((i) => i.kind === "executor.result");
    return { owner, run, cards };
  }

  it("失败 → 简报组普通级卡片，带原因；知道了可收掉", async () => {
    const { owner, run, cards } = await setup();
    await run("failed", { summary: "没登上", error: "密码错误" });
    const [c] = await cards();
    if (!c) throw new Error("no card");
    expect(c.group).toBe("brief");
    expect(c.urgency).toBe("normal");
    expect(c.title).toContain("签到没成功");
    expect(c.title).toContain("example.com");
    expect(c.summary).toContain("密码错误");
    expect((await owner("POST", `/api/inbox/${c.id}/actions/ack`, {})).statusCode).toBe(200);
    expect(await cards()).toHaveLength(0);
  });

  it("成功 → 低紧急度简报卡；取消 → 不出卡", async () => {
    const { run, cards } = await setup();
    await run("succeeded", { summary: "已签到，获得 5 额度" });
    await run("cancelled", { summary: "用户取消" });
    const all = await cards();
    expect(all).toHaveLength(1);
    expect(all[0]?.urgency).toBe("low");
    expect(all[0]?.title).toContain("签到完成");
  });
});
