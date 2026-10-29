/**
 * 浏览器驱动合同测试：每个 BrowserDriver 实现都跑同一套（现在：ego lite（经假 ego-browser 运行时）、内存假驱动）。
 * 接 Playwright MCP 时，把它加进 DRIVERS 即可。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildScript, EgoLiteDriver, parseOutput, type EgoExec } from '../src/adapters/ego-lite.js';
import { PlaywrightMcpDriver, pageField, snapshotBody } from '../src/adapters/playwright-mcp.js';
import { DriverBrowserPort } from '../src/agent/driver-session.js';
import { findRef, RuleBasedPlanner, detectBlockerInSnapshot } from '../src/agent/planner.js';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { assertRef, DriverError, type BrowserDriver } from '../src/ports/driver.js';
import { Runner } from '../src/runner.js';
import { HttpTransport } from '../src/transport.js';
import { MockCore, TEST_TOKEN } from './mock-core.js';

const FAKE_EGO = fileURLToPath(new URL('./fixtures/fake-ego.mjs', import.meta.url));
const FAKE_PW = fileURLToPath(new URL('./fixtures/fake-playwright-mcp.mjs', import.meta.url));
const VALUE = 'Contract-Secret-7731';

function fakeEgoExec(statePath: string, scripts: string[], outputs: string[]): EgoExec {
  return (script, timeoutMs) =>
    new Promise((resolve, reject) => {
      scripts.push(script);
      const child = spawn(process.execPath, [FAKE_EGO, 'nodejs'], { env: { ...process.env, FAKE_EGO_STATE: statePath }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      const t = setTimeout(() => {
        child.kill();
        reject(new Error('timeout'));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (stdout += d));
      child.stderr.resume();
      child.on('close', (code) => {
        clearTimeout(t);
        outputs.push(stdout);
        resolve({ code, stdout });
      });
      child.stdin.end(script, 'utf8');
    });
}

interface Harness {
  driver: BrowserDriver;
  scripts: string[];
  outputs: string[];
  /** 假登录页上的元素引用（各驱动格式不同） */
  refs: { user: string; pass: string; login: string };
}

const DRIVERS: Record<string, () => Harness> = {
  'ego-lite（假运行时）': () => {
    const dir = mkdtempSync(join(tmpdir(), 'ego-'));
    const scripts: string[] = [];
    const outputs: string[] = [];
    return {
      driver: new EgoLiteDriver({ exec: fakeEgoExec(join(dir, 'state.json'), scripts, outputs), timeoutMs: 10_000 }),
      scripts,
      outputs,
      refs: { user: '@1', pass: '@2', login: '@3' },
    };
  },
  'playwright-mcp（假 MCP 服务）': () => ({
    driver: new PlaywrightMcpDriver({ command: process.execPath, args: [FAKE_PW] }),
    scripts: [],
    outputs: [],
    refs: { user: 'e1', pass: 'e2', login: 'e3' },
  }),
};

for (const [name, make] of Object.entries(DRIVERS)) {
  describe(`驱动合同：${name}`, () => {
    let h: Harness;
    beforeEach(() => {
      h = make();
    });

    it('可用性探测', async () => {
      expect(await h.driver.available()).toBe(true);
    });

    it('打开、导航、读 URL 和快照', async () => {
      const s = await h.driver.open('t1');
      await s.goto('https://example.com/login');
      expect(await s.url()).toBe('https://example.com/login');
      const snap = await s.snapshot();
      expect(findRef(snap, ['button'], ['登录'])).toBe(h.refs.login);
      expect(await s.title()).toBeTypeOf('string');
      const info = await s.screenshotInfo();
      expect(info.width).toBeGreaterThan(0);
      await s.close();
    });

    it('同一工作空间跨多次调用保持状态（每次是新进程）', async () => {
      const s = await h.driver.open('t2');
      await s.goto('https://example.com/login');
      await s.fill(h.refs.user, VALUE);
      await s.click(h.refs.login);
      expect(await s.url()).toBe('https://example.com/home');
      await s.close();
    });

    it('填写的值不出现在子进程输出里', async () => {
      const s = await h.driver.open('t3');
      await s.goto('https://example.com/login');
      await s.fill(h.refs.pass, VALUE);
      expect(h.outputs.join('\n')).not.toContain(VALUE);
      expect(await s.snapshot()).not.toContain(VALUE);
      expect(await s.url()).not.toContain(VALUE);
      await s.close();
    });

    it('乱编的元素引用在到达浏览器前被拒绝', async () => {
      const s = await h.driver.open('t4');
      const before = h.scripts.length;
      await expect(s.click('@1"); evil("')).rejects.toBeInstanceOf(DriverError);
      await expect(s.press('@1', 'Enter"); x("')).rejects.toBeInstanceOf(DriverError);
      expect(h.scripts.length).toBe(before);
      await s.close();
    });

    it('关闭后不能再操作', async () => {
      const s = await h.driver.open('t5');
      await s.close();
      await expect(s.url()).rejects.toThrow();
    });

    it('交给所有者（handOff）', async () => {
      const s = await h.driver.open('t6');
      expect(typeof (await s.handOff())).toBe('boolean');
      await s.close();
    });
  });
}

describe('ego lite 脚本生成与解析', () => {
  it('值经 JSON 转义内嵌，不会打断脚本', () => {
    const sc = buildScript('aroomo-x', '  __out({ ok: true, data: "a\\"b" });');
    expect(sc).toContain('taskSpace("aroomo-x")');
  });
  it('解析最后一行结果；错误转成 DriverError', () => {
    expect(parseOutput<number>({ code: 0, stdout: 'noise\n__AROOMO__{"ok":true,"data":3}\n' })).toBe(3);
    expect(() => parseOutput({ code: 0, stdout: '__AROOMO__{"ok":false,"code":"EGO_X","message":"m"}' })).toThrow(DriverError);
    expect(() => parseOutput({ code: 1, stdout: '' })).toThrow(/没有返回/);
  });
  it('没装 ego-browser 时 available() 为 false', async () => {
    const d = new EgoLiteDriver({ command: 'definitely-not-ego-browser-xyz' });
    expect(await d.available()).toBe(false);
  });
  it('引用格式校验', () => {
    expect(assertRef('@12')).toBe('@12');
    expect(assertRef('e12')).toBe('e12');
    expect(() => assertRef('@1"x')).toThrow();
    expect(() => assertRef('e1 e2')).toThrow();
    expect(() => assertRef('')).toThrow();
  });
});

describe('Playwright MCP 响应解析', () => {
  it('取页面地址、标题与 yaml 快照', () => {
    const t = '### Page state\n- Page URL: https://a.com/x\n- Page Title: T\n- Page Snapshot:\n```yaml\n- button "登录" [ref=e3]\n```';
    expect(pageField(t, 'URL')).toBe('https://a.com/x');
    expect(pageField(t, 'Title')).toBe('T');
    expect(snapshotBody(t)).toBe('- button "登录" [ref=e3]\n');
    expect(findRef(snapshotBody(t), ['button'], ['登录'])).toBe('e3');
  });
  it('没装时 available() 为 false', async () => {
    expect(await new PlaywrightMcpDriver({ command: 'definitely-not-npx-xyz', args: [] }).available()).toBe(false);
  });
});

describe('规则规划器', () => {
  it('识别验证码、两步验证、付款', () => {
    expect(detectBlockerInSnapshot('@1 heading "请完成人机验证"')?.blocker).toBe('captcha');
    expect(detectBlockerInSnapshot('@1 textbox "短信验证码"')?.blocker).toBe('2fa');
    expect(detectBlockerInSnapshot('@1 textbox "Card number"')?.blocker).toBe('payment');
    expect(detectBlockerInSnapshot('@1 button "签到"')).toBeNull();
  });
  it('登录页：先填字段再点登录', async () => {
    const steps = await new RuleBasedPlanner().plan({
      instruction: '点击登录按钮',
      snapshot: '@1 textbox "用户名"\n@2 textbox "密码"\n@3 button "登录"',
      availableFields: ['username', 'password'],
      round: 0,
    });
    expect(steps).toEqual([
      { op: 'fill', ref: '@1', valueKey: 'username' },
      { op: 'fill', ref: '@2', valueKey: 'password' },
      { op: 'click', ref: '@3' },
    ]);
  });
});

describe('端到端：执行员 + ego lite 驱动（假运行时）+ 模拟 Core', () => {
  let core: MockCore;
  let ac: AbortController;
  beforeEach(async () => {
    core = new MockCore();
    await core.start();
    ac = new AbortController();
  });
  afterEach(async () => {
    ac.abort();
    await core.stop();
  });

  function start(which = 'ego-lite（假运行时）') {
    const h = DRIVERS[which]!();
    const runner = new Runner({
      transport: new HttpTransport({ baseUrl: core.url, getToken: () => TEST_TOKEN, version: '0.1.0', timeoutMs: 15_000 }),
      allowlist: new Allowlist({ sites: ['example.com'], commands: [] }),
      browsers: [new DriverBrowserPort(h.driver, new RuleBasedPlanner())],
      logger: createLogger({ sink: () => undefined }),
      deviceName: 't',
      platform: 't',
      version: '0.1.0',
      backoff: new Backoff(20, 100, () => 0),
    });
    void runner.run(ac.signal);
    return h;
  }

  it('登录任务：从保险箱取凭据、填表、登录成功', async () => {
    const h = start();
    const t = core.enqueue({
      kind: 'login',
      site: 'https://example.com/login',
      secrets: [
        { secretId: 's', field: 'username' },
        { secretId: 's', field: 'password' },
      ],
    });
    core.secrets.set('s:username', 'baobao');
    core.secrets.set('s:password', VALUE);
    await core.waitFor(() => core.results.has(t.id), 20_000);
    const r = core.results.get(t.id)!;
    expect(r.status).toBe('succeeded');
    expect(r.screenshot?.summary).toContain('example.com/home');
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(h.outputs.join('')).not.toContain(VALUE);
  }, 30_000);

  it('登录任务：Playwright MCP 备选驱动同样成功', async () => {
    start('playwright-mcp（假 MCP 服务）');
    const t = core.enqueue({
      kind: 'login',
      site: 'https://example.com/login',
      secrets: [
        { secretId: 's', field: 'username' },
        { secretId: 's', field: 'password' },
      ],
    });
    core.secrets.set('s:username', 'baobao');
    core.secrets.set('s:password', VALUE);
    await core.waitFor(() => core.results.has(t.id), 20_000);
    const r = core.results.get(t.id)!;
    expect(r.status).toBe('succeeded');
    expect(JSON.stringify(r)).not.toContain(VALUE);
  }, 30_000);

  it('验证码页：推接管卡', async () => {
    start();
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/captcha' });
    await core.waitFor(() => core.takeovers.size > 0, 20_000);
    expect([...core.takeovers.values()][0]!.req.reason).toBe('captcha');
    core.resolveTakeover(t.id, 'cancelled');
    await core.waitFor(() => core.results.has(t.id), 20_000);
    expect(core.results.get(t.id)!.status).toBe('cancelled');
  }, 30_000);
});
