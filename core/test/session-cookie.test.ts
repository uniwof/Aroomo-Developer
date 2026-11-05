import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { memoryDeps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { clearSessionCookie, readSessionCookie, sessionCookie } from "../src/auth/session-cookie.js";
import { OWNER_TOKEN, fakeClock, ownerAuth } from "./helpers/db.js";

const PW = "correct-horse-battery";

describe("控制台会话 Cookie（A 类：鉴权）", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup() {
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: "silent", CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: "off" }), memoryDeps(fakeClock().now));
    apps.push(app);
    const inv = await app.inject({ method: "POST", url: "/api/users/invites", headers: ownerAuth, payload: { email: "ann@example.com" } });
    const acc = await app.inject({ method: "POST", url: "/auth/accept", payload: { token: inv.json().token, password: PW } });
    const bearer = acc.json().token as string;
    const cookieLogin = async (headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/auth/login", headers, payload: { email: "ann@example.com", password: PW, cookie: true } });
    return { app, bearer, cookieLogin };
  }
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers["set-cookie"]);
  const pair = (setCookie: string) => setCookie.split(";")[0]!;

  it("cookie:true 登录：响应不带 token，Set-Cookie 是 HttpOnly + SameSite=Strict；https 时加 Secure", async () => {
    const { cookieLogin } = await setup();
    const r = await cookieLogin();
    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeUndefined();
    expect(r.json().user.email).toBe("ann@example.com");
    const c = cookieOf(r);
    expect(c).toMatch(/^aroomo_session=ars_/);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Secure");
    // https：__Host- 前缀，Secure、Path=/、不带 Domain（staging 不能顶替生产的 Cookie，#264 必改 1）
    const s = cookieOf(await cookieLogin({ "x-forwarded-proto": "https" }));
    expect(s).toMatch(/^__Host-aroomo_session=ars_/);
    expect(s).toContain("Secure");
    expect(s).toContain("Path=/");
    expect(s).not.toMatch(/Domain=/i);
  });

  it("过渡：https 上旧名 aroomo_session 仍能读；两个都在时以 __Host- 为准；退出两个名字一起清", async () => {
    const { app, cookieLogin } = await setup();
    const tok = pair(cookieOf(await cookieLogin({ "x-forwarded-proto": "https" }))).split("=")[1]!;
    const https = { "x-forwarded-proto": "https" };
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { ...https, cookie: `aroomo_session=${tok}` } })).statusCode).toBe(200);
    // 被顶替的旧名 Cookie（比如别的子域写进来的）不会盖过 __Host- 的
    expect(readSessionCookie(`aroomo_session=ars_planted0000; __Host-aroomo_session=${tok}`)).toBe(tok);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...https, cookie: `__Host-aroomo_session=${tok}`, "x-aroomo-request": "1" } });
    expect(out.statusCode).toBe(204);
    const cleared = ([] as string[]).concat(out.headers["set-cookie"] as string | string[]);
    expect(cleared.some((c) => c.startsWith("__Host-aroomo_session=; Max-Age=0") && c.includes("Secure"))).toBe(true);
    expect(cleared.some((c) => c.startsWith("aroomo_session=; Max-Age=0"))).toBe(true);
  });

  it("不要 cookie 的登录照旧返回 token、不写 Cookie", async () => {
    const { app } = await setup();
    const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "ann@example.com", password: PW } });
    expect(r.json().token).toMatch(/^ars_/);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("Cookie 能读（GET）；改动类请求没有 X-Aroomo-Request 头 403，带了就行", async () => {
    const { app, cookieLogin } = await setup();
    const ck = pair(cookieOf(await cookieLogin()));
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: ck } })).statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: ck }, payload: { currentPassword: PW, newPassword: "another-long-password-1" } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("CSRF");
    const ok = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: ck, "x-aroomo-request": "1" }, payload: { currentPassword: PW, newPassword: "another-long-password-1" } });
    expect(ok.statusCode).toBe(204);
  });

  it("退出登录：清 Cookie，旧 Cookie 立刻失效", async () => {
    const { app, cookieLogin } = await setup();
    const ck = pair(cookieOf(await cookieLogin()));
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: ck, "x-aroomo-request": "1" } });
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out)).toContain("Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: ck } })).statusCode).toBe(401);
  });

  it("Cookie 不能冒充所有者令牌或其他令牌；乱写的 Cookie 401；有 Bearer 时以 Bearer 为准", async () => {
    const { app, bearer } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `aroomo_session=${OWNER_TOKEN}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: "aroomo_session=garbage-value-123" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    // Bearer 不需要 CSRF 头
    const r = await app.inject({ method: "POST", url: "/api/auth/password", headers: { authorization: `Bearer ${bearer}` }, payload: { currentPassword: PW, newPassword: "another-long-password-1" } });
    expect(r.statusCode).toBe(204);
  });

  it("Cookie 字符串解析", () => {
    expect(readSessionCookie("a=b; aroomo_session=ars_abcdefgh12; c=d")).toBe("ars_abcdefgh12");
    expect(readSessionCookie("aroomo_session=bad value")).toBeNull();
    expect(readSessionCookie("other=1")).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie("__Host-aroomo_session=ars_abcdefgh12")).toBe("ars_abcdefgh12");
    expect(readSessionCookie("__Host-aroomo_session=bad value; aroomo_session=ars_abcdefgh12")).toBeNull();
    expect(sessionCookie("ars_abcdefgh12", new Date(1000 * 100), new Date(0), true)).toBe("__Host-aroomo_session=ars_abcdefgh12; Max-Age=100; Path=/; HttpOnly; SameSite=Strict; Secure");
    expect(sessionCookie("ars_abcdefgh12", new Date(1000 * 100), new Date(0), false)).toBe("aroomo_session=ars_abcdefgh12; Max-Age=100; Path=/; HttpOnly; SameSite=Strict");
    expect(clearSessionCookie(false)).toEqual(["aroomo_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"]);
  });
});
