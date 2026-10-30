import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { HttpTransport } from '../src/transport.js';
import { FakeBrowser, type FakeScript } from './fake-browser.js';
import { MockCore, TEST_TOKEN } from './mock-core.js';

const SECRET_PW = 'Pw-for-test-only-9271';
const SECRET_USER = 'baobao@example.com';

let core: MockCore;
let ac: AbortController;
let logs: string[];

function makeRunner(script: FakeScript = {}, opts: { token?: string; browsers?: FakeBrowser[] } = {}) {
  const browser = new FakeBrowser('fake', script);
  const runner = new Runner({
    transport: new HttpTransport({ baseUrl: core.url, getToken: () => opts.token ?? TEST_TOKEN, version: '0.1.0', timeoutMs: 3000 }),
    allowlist: new Allowlist({ sites: ['example.com', '*.example.org'], commands: [] }),
    browsers: opts.browsers ?? [browser],
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    deviceName: 'test-pc',
    platform: 'test',
    version: '0.1.0',
    authRetryMs: 50,
    backoff: new Backoff(20, 100, () => 0),
  });
  const done = runner.run(ac.signal);
  return { runner, browser, done };
}

beforeEach(async () => {
  core = new MockCore();
  await core.start();
  ac = new AbortController();
  logs = [];
});

afterEach(async () => {
  ac.abort();
  await core.stop();
});

describe('执行员 ↔ 模拟 Core', () => {
  it('上线登记后领取签到任务并回报成功', async () => {
    const { browser, done } = makeRunner({ actReplies: { 签到: '今天已签到，获得 5 积分' } });
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/daily' });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.hellos).toBe(1);
    const r = core.results.get(t.id)!;
    expect(r.status).toBe('succeeded');
    expect(r.summary).toContain('5 积分');
    expect(r.screenshot?.summary).toContain('example.com');
    expect(core.progress.filter((p) => p.taskId === t.id).map((p) => p.body.stage)).toContain('act');
    expect(browser.sessions[0]?.closed).toBe(true);
    ac.abort();
    await done;
  });

  it('登录：运行时取凭据，凭据不出现在任何上报和日志里', async () => {
    const { browser } = makeRunner({ actReplies: { 判断: '成功', 点击登录: `已提交 ${SECRET_USER}` } });
    const t = core.enqueue({
      kind: 'login',
      site: 'https://example.com/login',
      secrets: [
        { secretId: 's1', field: 'email' },
        { secretId: 's1', field: 'password' },
      ],
    });
    core.secrets.set('s1:email', SECRET_USER);
    core.secrets.set('s1:password', SECRET_PW);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
    expect(browser.sessions[0]!.filled.map((f) => f.value)).toEqual([SECRET_USER, SECRET_PW]);
    const everything = core.rawBodies.join('\n') + logs.join('\n');
    expect(everything).not.toContain(SECRET_PW);
    expect(everything).not.toContain(SECRET_USER);
    expect(everything).not.toContain(TEST_TOKEN);
  });

  it('遇验证码推接管卡，所有者处理后继续完成', async () => {
    makeRunner({ blockers: [{ reason: 'captcha', message: '页面出现滑块验证码' }, null] });
    const t = core.enqueue({ kind: 'browse', site: 'https://www.example.org/', instruction: '截图首页' });
    await core.waitFor(() => [...core.takeovers.values()].some((x) => x.taskId === t.id));
    const tk = [...core.takeovers.values()].find((x) => x.taskId === t.id)!;
    expect(tk.req.reason).toBe('captcha');
    expect(core.results.has(t.id)).toBe(false);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
  });

  it('所有者在接管卡上取消 → 回报 cancelled', async () => {
    makeRunner({ blockers: [{ reason: 'payment', message: '要付款' }] });
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id, 'cancelled');
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('cancelled');
  });

  it('白名单外的网站：不访问，推 not_allowed 卡并失败', async () => {
    const { browser } = makeRunner();
    const t = core.enqueue({ kind: 'checkin', site: 'https://not-allowed.io/' });
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NOT_ALLOWED');
    expect(browser.sessions[0]!.url).toBe('about:blank');
  });

  it('页面跳出白名单：停止并失败', async () => {
    makeRunner({ redirectTo: 'https://phish.example.net/' });
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NOT_ALLOWED');
  });

  it('不能取任务没声明的凭据', async () => {
    const { runner } = makeRunner();
    void runner;
    const t = core.enqueue({ kind: 'login', site: 'https://example.com/', secrets: [] });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NO_SECRET');
    expect(core.secretCalls).toBe(0);
  });

  it('Core 下发取消 → 停止并回报 cancelled', async () => {
    makeRunner();
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/', instruction: '做点事' });
    core.cancelTasks.add(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('cancelled');
  });

  it('租约被收回：立刻停止且不提交结果', async () => {
    const { runner } = makeRunner();
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    core.leaseLostTasks.add(t.id);
    await core.waitFor(() => runner.completed === 1);
    expect(core.results.has(t.id)).toBe(false);
  });

  it('断线重连：Core 重启后继续领任务', async () => {
    const { runner } = makeRunner();
    await core.waitFor(() => runner.state === 'online');
    const port = core.port;
    await core.stop();
    await core.waitFor(() => runner.state === 'reconnecting');
    await core.start(port);
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
    expect(core.hellos).toBeGreaterThanOrEqual(1);
  });

  it('503 时退避重试', async () => {
    core.failNext = 2;
    const { runner } = makeRunner();
    await core.waitFor(() => runner.state === 'online');
    expect(core.hellos).toBe(1);
  });

  it('令牌无效：进入 auth_failed，不领任务，日志不含令牌', async () => {
    const { runner } = makeRunner({}, { token: 'wrong-token-value-123456' });
    core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => runner.state === 'auth_failed');
    expect(core.claimed.size).toBe(0);
    expect(logs.join('')).not.toContain('wrong-token-value-123456');
  });

  it('没有可用浏览器：回报 NO_BROWSER', async () => {
    makeRunner({}, { browsers: [new FakeBrowser('ego-lite', {}, false)] });
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NO_BROWSER');
  });

  it('主选不可用时用备选适配器', async () => {
    const backup = new FakeBrowser('playwright-mcp');
    makeRunner({}, { browsers: [new FakeBrowser('ego-lite', {}, false), backup] });
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => core.results.has(t.id));
    expect(backup.sessions.length).toBe(1);
  });

  it('注册：带「封号即丢弃」标记', async () => {
    makeRunner();
    const t = core.enqueue({ kind: 'signup', site: 'https://example.com/register', options: { markDisposable: true } });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.summary).toContain('封号即丢弃');
  });
});

describe('结果核对', () => {
  it('签到：页面说失败就报失败，不当成功', async () => {
    makeRunner({ actReplies: { 判断签到结果: '失败：今天的名额已满' } });
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/daily' });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('CHECKIN_FAILED');
  });

  it('注册：页面说失败就报失败', async () => {
    makeRunner({ actReplies: { 判断注册结果: '失败：用户名已被占用' } });
    const t = core.enqueue({ kind: 'signup', site: 'https://example.com/register' });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('SIGNUP_FAILED');
  });

  it('注册：需要验证邮件时推接管卡，处理后继续', async () => {
    makeRunner({ actReplies: { 判断注册结果: '需要验证邮件' } });
    const t = core.enqueue({ kind: 'signup', site: 'https://example.com/register' });
    await core.waitFor(() => core.takeovers.size > 0);
    const [card] = [...core.takeovers.values()];
    expect(card?.req.reason).toBe('2fa');
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
  });
});

describe('HttpTransport', () => {
  it('非本机地址必须 https', () => {
    expect(() => new HttpTransport({ baseUrl: 'http://app.example.com', getToken: () => 'x', version: '0' })).toThrow();
    expect(() => new HttpTransport({ baseUrl: 'https://app.example.com', getToken: () => 'x', version: '0' })).not.toThrow();
  });
});
