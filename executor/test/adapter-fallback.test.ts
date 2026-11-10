/**
 * #382：可选适配器（ego lite）探活失败 / 打开卡住 → 降级到 playwright-mcp；act 卡住 → 限时明确失败，不挂起、不假成功。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriverBrowserPort } from '../src/agent/driver-session.js';
import { RuleBasedPlanner } from '../src/agent/planner.js';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { openBrowser, probe, type BrowserPort, type BrowserSession } from '../src/ports/browser.js';
import type { BrowserDriver, DriverSession } from '../src/ports/driver.js';
import { Runner } from '../src/runner.js';
import { HttpTransport } from '../src/transport.js';
import { FakeBrowser, FakeSession } from './fake-browser.js';
import { MockCore, TEST_TOKEN } from './mock-core.js';

const never = <T>() => new Promise<T>(() => undefined);

/** 可配置坏法的「ego lite」端口 */
class BadEgo implements BrowserPort {
  readonly name = 'ego-lite';
  lateSession: FakeSession | null = null;
  constructor(private readonly mode: 'probe-hang' | 'probe-throw' | 'probe-truthy' | 'open-hang' | 'open-late' | 'open-throw') {}
  async available(): Promise<boolean> {
    if (this.mode === 'probe-hang') return never();
    if (this.mode === 'probe-throw') throw new Error('ego-browser 没装');
    if (this.mode === 'probe-truthy') return 'yes' as unknown as boolean;
    return true;
  }
  async open(): Promise<BrowserSession> {
    if (this.mode === 'open-hang') return never();
    if (this.mode === 'open-throw') throw new Error('打不开');
    await new Promise((r) => setTimeout(r, 150));
    this.lateSession = new FakeSession({});
    return this.lateSession;
  }
}

/** 快照永远不返回的驱动（模拟 ego-browser 调用卡住） */
function hangingDriver(calls: string[]): BrowserDriver {
  const s: DriverSession = {
    goto: async () => undefined,
    url: async () => 'https://example.com/daily',
    title: async () => '',
    snapshot: () => {
      calls.push('snapshot');
      return never();
    },
    click: async () => void calls.push('click'),
    fill: async () => void calls.push('fill'),
    press: async () => void calls.push('press'),
    screenshotInfo: async () => ({ width: 1, height: 1 }),
    handOff: async () => false,
    close: async () => void calls.push('close'),
  };
  return { name: 'ego-lite', available: async () => true, open: async () => s };
}

/** 快照晚到的驱动：超时后才返回，用来确认后台循环不会再点页面 */
function slowDriver(calls: string[], delayMs: number): BrowserDriver {
  const s: DriverSession = {
    goto: async () => undefined,
    url: async () => 'https://example.com/daily',
    title: async () => '',
    snapshot: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return '@1 button "签到"';
    },
    click: async () => void calls.push('click'),
    fill: async () => void calls.push('fill'),
    press: async () => void calls.push('press'),
    screenshotInfo: async () => ({ width: 1, height: 1 }),
    handOff: async () => false,
    close: async () => undefined,
  };
  return { name: 'ego-lite', available: async () => true, open: async () => s };
}

describe('探活', () => {
  it('卡住 / 抛错 / 不是明确的 true → 都算不可用，且在时限内返回', async () => {
    const t0 = Date.now();
    expect(await probe(new BadEgo('probe-hang'), 100)).toBe(false);
    expect(await probe(new BadEgo('probe-throw'), 100)).toBe(false);
    expect(await probe(new BadEgo('probe-truthy'), 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await probe(new FakeBrowser('playwright-mcp'), 100)).toBe(true);
  });
});

describe('选适配器：ego lite 不行就降级到 playwright-mcp', () => {
  for (const mode of ['probe-hang', 'probe-throw', 'probe-truthy', 'open-hang', 'open-throw'] as const) {
    it(`ego lite ${mode} → 用 playwright-mcp，不挂起`, async () => {
      const pw = new FakeBrowser('playwright-mcp');
      const t0 = Date.now();
      const r = await openBrowser([new BadEgo(mode), pw], {}, { probeMs: 100, openMs: 100 });
      expect(r?.port.name).toBe('playwright-mcp');
      expect(pw.sessions).toHaveLength(1);
      expect(Date.now() - t0).toBeLessThan(1000);
    });
  }

  it('超时后才打开成功的 ego 会话会被关掉，不留后台窗口', async () => {
    const ego = new BadEgo('open-late');
    const r = await openBrowser([ego, new FakeBrowser('playwright-mcp')], {}, { probeMs: 100, openMs: 50 });
    expect(r?.port.name).toBe('playwright-mcp');
    await new Promise((res) => setTimeout(res, 250));
    expect(ego.lateSession?.closed).toBe(true);
  });

  it('全都不行 → null（由 runner 报 NO_BROWSER）', async () => {
    expect(await openBrowser([new BadEgo('probe-hang'), new BadEgo('open-hang')], {}, { probeMs: 50, openMs: 50 })).toBeNull();
  });
});

describe('act 限时', () => {
  it('驱动卡住：在时限内以 ACT_TIMEOUT 明确失败', async () => {
    const calls: string[] = [];
    const s = await new DriverBrowserPort(hangingDriver(calls), new RuleBasedPlanner(), { actTimeoutMs: 150 }).open();
    const t0 = Date.now();
    await expect(s.act('找到签到按钮并点击')).rejects.toMatchObject({ code: 'ACT_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls).not.toContain('click');
  });

  it('超时后晚到的快照不再触发点击', async () => {
    const calls: string[] = [];
    const s = await new DriverBrowserPort(slowDriver(calls, 200), new RuleBasedPlanner(), { actTimeoutMs: 80 }).open();
    await expect(s.act('找到签到按钮并点击')).rejects.toMatchObject({ code: 'ACT_TIMEOUT' });
    await new Promise((r) => setTimeout(r, 350));
    expect(calls).toEqual([]);
  });
});

describe('执行员整体（模拟 Core）', () => {
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

  function runner(browsers: BrowserPort[]) {
    const r = new Runner({
      transport: new HttpTransport({ baseUrl: core.url, getToken: () => TEST_TOKEN, version: '0.1.0', timeoutMs: 3000 }),
      allowlist: new Allowlist({ sites: ['example.com'], commands: [] }),
      browsers,
      logger: createLogger({ level: 'error', sink: () => undefined }),
      deviceName: 'test-pc',
      platform: 'test',
      version: '0.1.0',
      backoff: new Backoff(20, 100, () => 0),
      browserTimeouts: { probeMs: 100, openMs: 100 },
    });
    void r.run(ac.signal);
  }

  it('签到：ego lite 探活卡住 → playwright-mcp 完成签到，几秒内结束', async () => {
    const pw = new FakeBrowser('playwright-mcp', { actReplies: { 签到: '今天已签到' } });
    runner([new BadEgo('probe-hang'), pw]);
    const t0 = Date.now();
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/daily' });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
    expect(pw.sessions).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('签到：act 卡住 → 回报 failed / ACT_TIMEOUT，不挂起、不假成功', async () => {
    const calls: string[] = [];
    runner([new DriverBrowserPort(hangingDriver(calls), new RuleBasedPlanner(), { actTimeoutMs: 200 })]);
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/daily' });
    await core.waitFor(() => core.results.has(t.id));
    const r = core.results.get(t.id)!;
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('ACT_TIMEOUT');
    expect(calls).toContain('close');
  });
});
