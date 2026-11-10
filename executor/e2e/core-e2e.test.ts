/**
 * 联调：真实 Core（内存库，真 HTTP）+ 真实执行员 Runner（假浏览器）。
 * 全链路 hello → claim → progress → secret → takeover → result，并验证越权。
 * 运行：先在 core/ 里 npm ci，再在 executor/ 里 npm run test:e2e
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../core/src/config.js';
import { memoryDeps } from '../../core/src/deps.js';
import { buildServer } from '../../core/src/server.js';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { HttpTransport } from '../src/transport.js';
import { FakeBrowser, type FakeScript } from '../test/fake-browser.js';

const OWNER = 'placeholder-owner-token-0123456789abcdef';
const PW = 'correct-horse-battery';
const SECRET_VALUE = 'Pw-e2e-only-5521';

type Call = (method: 'GET' | 'POST', url: string, payload?: object) => Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance;
let base: string;
let logs: string[];
let ac: AbortController;

function caller(token: string): Call {
  return async (method, url, payload) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, json: r.body ? r.json() : null };
  };
}

async function register(email: string): Promise<Call> {
  const inv = await caller(OWNER)('POST', '/api/users/invites', { email });
  const r = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json.token, password: PW } });
  return caller(r.json().token);
}

async function deviceToken(human: Call): Promise<string> {
  const r = await human('POST', '/api/clients', { name: 'pc', scopes: ['tasks:pull', 'tasks:secret'] });
  return r.json.token as string;
}

function startRunner(token: string, script: FakeScript = {}) {
  const browser = new FakeBrowser('fake', script);
  const runner = new Runner({
    transport: new HttpTransport({ baseUrl: base, getToken: () => token, version: '0.1.0', timeoutMs: 5000 }),
    allowlist: new Allowlist({ sites: ['example.com'], commands: [] }),
    browsers: [browser],
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    deviceName: 'e2e-pc',
    platform: 'test',
    version: '0.1.0',
    authRetryMs: 100,
    backoff: new Backoff(50, 200, () => 0),
  });
  void runner.run(ac.signal);
  return browser;
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
  logs = [];
  ac = new AbortController();
  app = buildServer(
    loadConfig({
      CORE_LOG_LEVEL: 'silent',
      CORE_OWNER_TOKEN: OWNER,
      CORE_ACCESS_REAUTH: 'off',
      VAULT_KEY: randomBytes(32).toString('base64'),
    }),
    memoryDeps(() => new Date()),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterEach(async () => {
  ac.abort();
  app.server.closeAllConnections();
  await app.close();
});

describe('执行员 ↔ 真实 Core', () => {
  it('登录任务：取凭据 → 遇验证码推接管卡 → 所有者处理 → 成功，凭据不进日志', async () => {
    const alice = await register('alice@example.com');
    const sid = (await alice('POST', '/api/vault', { name: 'site', kind: 'password', value: SECRET_VALUE })).json.secret.id as string;
    const token = await deviceToken(alice);
    const browser = startRunner(token, { blockers: [{ reason: 'captcha', message: '请处理验证码' }, null], actReplies: { 判断: '成功' } });
    const tid = (await alice('POST', '/api/tasks', { kind: 'login', site: 'https://example.com/login', secrets: [{ secretId: sid, field: 'password' }] })).json.task.id as string;

    const card = await until(async () => (await alice('GET', `/api/tasks/${tid}/takeovers`)).json.takeovers.find((t: { status: string }) => t.status === 'pending'));
    expect(card.reason).toBe('captcha');
    expect((await alice('GET', `/api/tasks/${tid}`)).json.task.status).not.toBe('succeeded');
    expect((await alice('POST', `/api/tasks/${tid}/takeovers/${card.id}/resolve`, {})).status).toBe(200);

    const task = await until(async () => {
      const t = (await alice('GET', `/api/tasks/${tid}`)).json.task;
      return ['succeeded', 'failed', 'cancelled'].includes(t.status) ? t : undefined;
    });
    expect(task.status).toBe('succeeded');
    expect(browser.sessions[0]!.filled.map((f) => f.value)).toContain(SECRET_VALUE);
    expect(JSON.stringify(task) + logs.join('\n')).not.toContain(SECRET_VALUE);
    expect(logs.join('\n')).not.toContain(token);
  });

  it('所有者取消接管卡 → 任务 cancelled', async () => {
    const alice = await register('alice2@example.com');
    const token = await deviceToken(alice);
    const browser = startRunner(token, { blockers: [{ reason: 'payment', message: '要付款' }] });
    const tid = (await alice('POST', '/api/tasks', { kind: 'browse', site: 'https://example.com/' })).json.task.id as string;
    const card = await until(async () => (await alice('GET', `/api/tasks/${tid}/takeovers`)).json.takeovers[0]);
    await alice('POST', `/api/tasks/${tid}/takeovers/${card.id}/resolve`, { cancel: true });
    const task = await until(async () => {
      const t = (await alice('GET', `/api/tasks/${tid}`)).json.task;
      return t.status === 'cancelled' ? t : undefined;
    });
    expect(task.status).toBe('cancelled');
    // M3 验收 4：放弃后浏览器页面关闭，不再重试（没有新会话，状态不变）
    await until(async () => browser.sessions[0]?.closed);
    await new Promise((r) => setTimeout(r, 1000));
    expect(browser.sessions).toHaveLength(1);
    expect((await alice('GET', `/api/tasks/${tid}`)).json.task.status).toBe('cancelled');
  });

  it('M3 验收 2：签到任务 排队中 → 进行中 → 成功，摘要写明已签到', async () => {
    const alice = await register('alice4@example.com');
    const token = await deviceToken(alice);
    const tid = (await alice('POST', '/api/tasks', { kind: 'checkin', site: 'https://example.com/daily' })).json.task.id as string;
    expect((await alice('GET', `/api/tasks/${tid}`)).json.task.status).toBe('queued');
    const browser = startRunner(token, { actReplies: { 签到: '今天已签到，获得 5 积分' }, actDelayMs: 600 });
    const seen: string[] = [];
    const task = await until(async () => {
      const t = (await alice('GET', `/api/tasks/${tid}`)).json.task;
      if (seen.at(-1) !== t.status) seen.push(t.status);
      return t.status === 'succeeded' ? t : undefined;
    });
    expect(seen).toContain('running');
    expect(seen.at(-1)).toBe('succeeded');
    expect(task.resultSummary).toContain('已签到');
    expect(browser.sessions[0]!.actions.every((a) => a.trim().length > 0)).toBe(true); // Core 没写 instruction 时用默认指令，不能给浏览器空指令
  });

  it('越权：B 的设备领不到 A 的任务，取不到 A 的凭据，A 的任务仍在排队', async () => {
    const alice = await register('alice3@example.com');
    const bob = await register('bob3@example.com');
    const sid = (await alice('POST', '/api/vault', { name: 'x', kind: 'password', value: SECRET_VALUE })).json.secret.id as string;
    const tid = (await alice('POST', '/api/tasks', { kind: 'login', site: 'https://example.com/', secrets: [{ secretId: sid, field: 'password' }] })).json.task.id as string;

    const bobTok = await deviceToken(bob);
    const bobDev = caller(bobTok);
    await bobDev('POST', '/api/executor/hello', { deviceName: 'bob-pc', platform: 'x', version: '1' });
    expect((await bobDev('POST', '/api/executor/tasks/claim', { waitSec: 0 })).status).toBe(204);
    const stolen = await bobDev('POST', `/api/executor/tasks/${tid}/secret`, { secretId: sid, field: 'password' });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(stolen.json)).not.toContain(SECRET_VALUE);
    expect((await bobDev('POST', `/api/executor/tasks/${tid}/result`, { status: 'succeeded', summary: 'x' })).status).toBeGreaterThanOrEqual(400);
    expect((await bob('GET', `/api/tasks/${tid}`)).status).toBe(404);
    expect((await alice('GET', `/api/tasks/${tid}`)).json.task.status).toBe('queued');
  });
});
