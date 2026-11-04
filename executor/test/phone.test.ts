import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DroidRunPhone, secretIdFor, type BridgeExec } from '../src/adapters/droidrun.js';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { blockerFromReason } from '../src/tasks/phone.js';
import { HttpTransport } from '../src/transport.js';
import { MockCore, TEST_TOKEN } from './mock-core.js';

const PW = 'Phone-Secret-8812';

function fakeBridge(replies: { success: boolean; reason: string }[], seen: string[]): BridgeExec {
  return async (input) => {
    seen.push(input);
    const job = JSON.parse(input) as { probe?: boolean };
    if (job.probe) return { code: 0, stdout: '__AROOMO__{"ok":true,"data":true}\n' };
    const r = replies.shift() ?? { success: true, reason: '完成' };
    return { code: 0, stdout: `noise\n__AROOMO__${JSON.stringify({ ok: true, data: { ...r, steps: 3 } })}\n` };
  };
}

describe('DroidRun 适配器', () => {
  it('secret id 规范化', () => {
    expect(secretIdFor('password')).toBe('PASSWORD');
    expect(secretIdFor('e-mail')).toBe('E_MAIL');
  });
  it('真实桥脚本：未安装 mobilerun 时 available() 为 false（也验证脚本能跑）', async () => {
    const p = new DroidRunPhone({ coreUrl: 'https://core.test', getToken: () => 't', python: process.platform === 'win32' ? 'python' : 'python3' });
    expect(await p.available()).toBe(false);
  }, 30_000);
  it('没装 Python 时 available() 为 false', async () => {
    expect(await new DroidRunPhone({ coreUrl: 'https://c', getToken: () => 't', python: 'no-such-python-xyz' }).available()).toBe(false);
  });
  it('识别停在验证码 / 两步验证 / 付款', () => {
    expect(blockerFromReason('遇到短信验证码，已停止')).toBe('2fa');
    expect(blockerFromReason('captcha shown')).toBe('captcha');
    expect(blockerFromReason('需要支付 6 元')).toBe('payment');
    expect(blockerFromReason('网络错误')).toBeNull();
  });
});

describe('手机任务端到端（模拟 Core + 假桥）', () => {
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

  function start(replies: { success: boolean; reason: string }[], seen: string[], phones = true) {
    const runner = new Runner({
      transport: new HttpTransport({ baseUrl: core.url, getToken: () => TEST_TOKEN, version: '0.1.0', timeoutMs: 5000 }),
      allowlist: new Allowlist({ sites: [], commands: [], apps: ['com.example.shop'] }),
      browsers: [],
      phones: phones ? [new DroidRunPhone({ coreUrl: core.url, getToken: () => TEST_TOKEN, exec: fakeBridge(replies, seen) })] : [],
      logger: createLogger({ sink: () => undefined }),
      deviceName: 't',
      platform: 't',
      version: '0.1.0',
      backoff: new Backoff(20, 100, () => 0),
    });
    void runner.run(ac.signal);
  }

  it('签到成功；凭据按 secret id 传给桥，目标文字里没有值', async () => {
    const seen: string[] = [];
    start([{ success: true, reason: '已签到，获得 10 金币' }], seen);
    const t = core.enqueue({ kind: 'checkin', site: 'android-app://com.example.shop', options: { device: 'phone' }, secrets: [{ secretId: 's', field: 'password' }] });
    core.secrets.set('s:password', PW);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.summary).toContain('10 金币');
    const job = JSON.parse(seen.find((x) => x.includes('goal'))!) as { goal: string; credentials: Record<string, string>; api_base: string };
    expect(job.credentials).toEqual({ PASSWORD: PW });
    expect(job.goal).not.toContain(PW);
    expect(job.goal).toContain('PASSWORD');
    expect(job.api_base).toBe(`${core.url}/v1`);
    expect(core.rawBodies.join('')).not.toContain(PW);
  });

  it('停在验证码 → 接管卡 → 所有者处理后再跑一次成功', async () => {
    start([{ success: false, reason: '出现滑块人机验证，已停止' }, { success: true, reason: '完成' }], []);
    const t = core.enqueue({ kind: 'login', site: 'android-app://com.example.shop', options: { device: 'phone' } });
    await core.waitFor(() => core.takeovers.size > 0);
    expect([...core.takeovers.values()][0]!.req.reason).toBe('captcha');
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
  });

  it('应用不在白名单：不执行', async () => {
    const seen: string[] = [];
    start([], seen);
    const t = core.enqueue({ kind: 'browse', site: 'android-app://com.other.app', options: { device: 'phone' } });
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NOT_ALLOWED');
    expect(seen.filter((x) => x.includes('goal'))).toHaveLength(0);
  });

  it('没启用手机：NO_PHONE', async () => {
    start([], [], false);
    const t = core.enqueue({ kind: 'browse', site: 'android-app://com.example.shop', options: { device: 'phone' } });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NO_PHONE');
  });
});
