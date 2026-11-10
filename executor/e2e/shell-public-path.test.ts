/**
 * #376 M2：真 Shell + 真 Core + 真 HttpTransport 端到端（执行员公网通路）。
 * 只有 Cloudflare 边缘是模拟的（fetchImpl 里核对 Service Token 两个头、换成 Access JWT），其余都是真进程内服务、真 HTTP。
 *  - hello → claim → progress → result 跑通；
 *  - 结论：Core 不依赖 x-aroomo-executor（按设备令牌的 clientId 认执行员），执行员不再发这个头；Core 一次都没收到它；
 *  - 反向：冒充别人的执行员 id（手写这个头）没用；缺头照常工作。
 */
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig as loadCoreConfig } from '../../core/src/config.js';
import { memoryDeps } from '../../core/src/deps.js';
import { buildServer } from '../../core/src/server.js';
import { loadConfig as loadShellConfig } from '../../shell/src/config.js';
import { createShellServer } from '../../shell/src/server.js';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { HttpTransport } from '../src/transport.js';
import { FakeBrowser } from '../test/fake-browser.js';

const OWNER = 'placeholder-owner-token-0123456789abcdef';
const PW = 'correct-horse-battery';
const TEAM = 'aroomo-e2e.cloudflareaccess.com';
const AUD = 'aud-executor-e2e';
const CF_ID = 'e2e-client-id.access';
const CF_SECRET = 'e2e-cf-secret-placeholder-0123456789';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...(key.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' }] };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function accessJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const p = b64({ iss: `https://${TEAM}`, aud: [AUD], exp: now + 300, iat: now, common_name: CF_ID, type: 'app' });
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.privateKey).toString('base64url')}`;
}

/** 模拟 Cloudflare 边缘：Service Token 两个头对了才放行，换成 Cf-Access-Jwt-Assertion；不对就 403（和 CF 一样） */
const edgeFetch: typeof fetch = async (input, init) => {
  const h = new Headers(init?.headers);
  if (h.get('cf-access-client-id') !== CF_ID || h.get('cf-access-client-secret') !== CF_SECRET) return new Response('forbidden', { status: 403 });
  h.delete('cf-access-client-id');
  h.delete('cf-access-client-secret');
  h.set('cf-access-jwt-assertion', accessJwt());
  return fetch(input, { ...init, headers: h });
};

let app: FastifyInstance;
let shell: Server;
let shellBase: string;
let ac: AbortController;
/** Core 收到的每个执行员请求里 x-aroomo-executor 的值（undefined = 没有） */
let coreSawExecutorHeader: (string | undefined)[];

const human = (token: string) => async (method: 'GET' | 'POST', url: string, payload?: object) => {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, json: r.body ? r.json() : null };
};

async function register(email: string) {
  const inv = await human(OWNER)('POST', '/api/users/invites', { email });
  const r = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json.token, password: PW } });
  return human(r.json().token as string);
}

async function deviceToken(h: Awaited<ReturnType<typeof register>>): Promise<string> {
  return (await h('POST', '/api/clients', { name: 'pc', scopes: ['tasks:pull', 'tasks:secret'] })).json.token as string;
}

/** 经「边缘 → Shell → Core」手写一个执行员请求（可带任意头），用来做反向用例 */
async function viaEdge(token: string, path: string, body: object, extra: Record<string, string> = {}) {
  const r = await edgeFetch(`${shellBase}/api/executor${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'cf-access-client-id': CF_ID, 'cf-access-client-secret': CF_SECRET, ...extra },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(async () => {
  ac = new AbortController();
  coreSawExecutorHeader = [];
  app = buildServer(
    loadCoreConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER, CORE_ACCESS_REAUTH: 'off', VAULT_KEY: randomBytes(32).toString('base64') }),
    memoryDeps(() => new Date()),
  );
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/executor/')) coreSawExecutorHeader.push(req.headers['x-aroomo-executor'] as string | undefined);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const coreBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  shell = createShellServer(
    loadShellConfig({
      SHELL_AUTH: 'core-session',
      CORE_UPSTREAM: coreBase,
      LOBE_UPSTREAM: 'http://127.0.0.1:9',
      CORE_OWNER_TOKEN: OWNER,
      SHELL_OWNER_EMAIL: 'owner@example.com',
      SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN: TEAM,
      SHELL_EXECUTOR_ACCESS_AUD: AUD,
      SHELL_EXECUTOR_ACCESS_CLIENT_ID: CF_ID,
    }),
    { fetchJwks: async () => jwks },
  );
  await new Promise<void>((r) => shell.listen(0, '127.0.0.1', () => r()));
  shellBase = `http://127.0.0.1:${(shell.address() as AddressInfo).port}`;
});

afterEach(async () => {
  ac.abort();
  shell.closeAllConnections();
  await new Promise((r) => shell.close(r));
  app.server.closeAllConnections();
  await app.close();
});

describe('#376 M2 真 Shell + 真 Core + 真 transport', () => {
  it('hello → claim → progress → result 跑通；Core 从没收到 x-aroomo-executor', async () => {
    const alice = await register('alice-pub@example.com');
    const token = await deviceToken(alice);
    const logs: string[] = [];
    const runner = new Runner({
      transport: new HttpTransport({ baseUrl: shellBase, getToken: () => token, version: '0.1.0', timeoutMs: 5000, fetchImpl: edgeFetch, cfAccess: { clientId: CF_ID, getSecret: () => CF_SECRET } }),
      allowlist: new Allowlist({ sites: ['example.com'], commands: [] }),
      browsers: [new FakeBrowser('fake', { actReplies: { 签到: '今天已签到，获得 5 积分' } })],
      logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
      deviceName: 'pub-pc',
      platform: 'test',
      version: '0.1.0',
      authRetryMs: 100,
      backoff: new Backoff(50, 200, () => 0),
    });
    void runner.run(ac.signal);
    const tid = (await alice('POST', '/api/tasks', { kind: 'checkin', site: 'https://example.com/daily' })).json.task.id as string;
    const task = await until(async () => {
      const t = (await alice('GET', `/api/tasks/${tid}`)).json.task;
      return t.status === 'succeeded' ? t : undefined;
    });
    expect(task.resultSummary).toContain('已签到');
    const execs = (await alice('GET', '/api/executors')).json.executors as { deviceName: string }[];
    expect(execs.map((e) => e.deviceName)).toEqual(['pub-pc']);
    // hello、claim、progress、result 都经过了 Shell 到 Core
    expect(coreSawExecutorHeader.length).toBeGreaterThanOrEqual(4);
    expect(coreSawExecutorHeader.every((v) => v === undefined)).toBe(true);
    expect(logs.join('\n')).not.toContain(CF_SECRET);
    expect(logs.join('\n')).not.toContain(token);
  });

  it('反向：冒充别人的执行员 id（手写 x-aroomo-executor）→ Core 收不到这个头，仍按令牌认人，领不到别人的任务', async () => {
    const alice = await register('alice-imp@example.com');
    const bob = await register('bob-imp@example.com');
    const aTok = await deviceToken(alice);
    const bTok = await deviceToken(bob);
    const aHello = await viaEdge(aTok, '/hello', { deviceName: 'alice-pc', platform: 'x', version: '1' });
    expect(aHello.status).toBe(200);
    const aliceExec = aHello.json.executorId as string;
    const tid = (await alice('POST', '/api/tasks', { kind: 'browse', site: 'https://example.com/' })).json.task.id as string;

    const forged = { 'x-aroomo-executor': aliceExec };
    const bHello = await viaEdge(bTok, '/hello', { deviceName: 'bob-pc', platform: 'x', version: '1' }, forged);
    expect(bHello.status).toBe(200);
    expect(bHello.json.executorId).not.toBe(aliceExec);
    expect((await viaEdge(bTok, '/tasks/claim', { waitSec: 0 }, forged)).status).toBe(204);
    expect((await viaEdge(bTok, `/tasks/${tid}/result`, { status: 'succeeded', summary: 'x' }, forged)).status).toBeGreaterThanOrEqual(400);
    expect(coreSawExecutorHeader.every((v) => v === undefined)).toBe(true);
    expect((await alice('GET', `/api/tasks/${tid}`)).json.task.status).toBe('queued');
    expect(((await alice('GET', '/api/executors')).json.executors as { deviceName: string }[]).map((e) => e.deviceName)).toEqual(['alice-pc']);
    expect(((await bob('GET', '/api/executors')).json.executors as { deviceName: string }[]).map((e) => e.deviceName)).toEqual(['bob-pc']);
  });

  it('反向：缺 x-aroomo-executor 头照常工作（hello、claim 领到自己的任务）', async () => {
    const alice = await register('alice-nohdr@example.com');
    const aTok = await deviceToken(alice);
    const tid = (await alice('POST', '/api/tasks', { kind: 'browse', site: 'https://example.com/' })).json.task.id as string;
    expect((await viaEdge(aTok, '/hello', { deviceName: 'a', platform: 'x', version: '1' })).status).toBe(200);
    const c = await viaEdge(aTok, '/tasks/claim', { waitSec: 0 });
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(tid);
  });
});
