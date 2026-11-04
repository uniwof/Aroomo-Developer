import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { HANDLERS } from '../src/tasks/handlers.js';
import { findRecipe, parseRecipes, withRecipes } from '../src/tasks/recipes.js';
import { HttpTransport } from '../src/transport.js';
import { FakeBrowser, type FakeScript } from './fake-browser.js';
import { MockCore, TEST_TOKEN } from './mock-core.js';
import example from '../examples/recipes.example.json' with { type: 'json' };

const PW = 'Pw-recipe-test-5530';
const USER = 'recipe-user@example.com';

describe('配方解析', () => {
  it('示例配方合格', () => {
    const r = parseRecipes(example);
    expect(r).toHaveLength(1);
    expect(r[0]!.steps.length).toBeGreaterThan(5);
  });
  it('拒绝写死的值、占位符、坏字段名、重复 id', () => {
    const mk = (step: unknown) => ({ recipes: [{ id: 'a', site: 'example.com', kind: 'login', steps: [step] }] });
    expect(() => parseRecipes(mk({ do: 'fill', fields: ['password'], value: 'x' }))).toThrow(/写死/);
    expect(() => parseRecipes(mk({ do: 'act', text: '输入 {{password}}' }))).toThrow(/占位符/);
    expect(() => parseRecipes(mk({ do: 'fill', fields: ['Pass Word'] }))).toThrow(/字段名/);
    expect(() => parseRecipes(mk({ do: 'run', cmd: 'rm' }))).toThrow(/do 只能是/);
    const dup = { recipes: [mk({ do: 'blockers' }).recipes[0], mk({ do: 'blockers' }).recipes[0]] };
    expect(() => parseRecipes(dup)).toThrow(/重复/);
  });
  it('精确主机名优先于通配', () => {
    const base = { kind: 'checkin', steps: [{ do: 'blockers' }] };
    const rs = parseRecipes({ recipes: [{ id: 'wild', site: '*.example.com', ...base }, { id: 'exact', site: 'www.example.com', ...base }] });
    expect(findRecipe(rs, 'checkin', 'https://www.example.com/x')?.id).toBe('exact');
    expect(findRecipe(rs, 'checkin', 'https://a.example.com/')?.id).toBe('wild');
    expect(findRecipe(rs, 'checkin', 'https://example.com/')).toBeUndefined();
    expect(findRecipe(rs, 'login', 'https://www.example.com/')).toBeUndefined();
  });
});

let core: MockCore;
let ac: AbortController;
let logs: string[];

function start(script: FakeScript, recipes: unknown) {
  const browser = new FakeBrowser('fake', script);
  const runner = new Runner({
    transport: new HttpTransport({ baseUrl: core.url, getToken: () => TEST_TOKEN, version: '0.1.0', timeoutMs: 3000 }),
    allowlist: new Allowlist({ sites: ['example.com'], commands: [] }),
    browsers: [browser],
    handlers: withRecipes(HANDLERS, parseRecipes(recipes)),
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    deviceName: 'test-pc',
    platform: 'test',
    version: '0.1.0',
    authRetryMs: 50,
    backoff: new Backoff(20, 100, () => 0),
  });
  return { browser, done: runner.run(ac.signal) };
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

const secrets = [
  { secretId: 's1', field: 'username' },
  { secretId: 's1', field: 'password' },
];

describe('配方执行', () => {
  it('命中配方：按步骤执行，凭据现取且不出现在上报和日志里', async () => {
    const { browser } = start({ actReplies: { 是否已登录: '已登录', 签到: '签到成功 +3' } }, example);
    core.secrets.set('s1:username', USER);
    core.secrets.set('s1:password', PW);
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/', secrets });
    await core.waitFor(() => core.results.has(t.id));
    const r = core.results.get(t.id)!;
    expect(r.status).toBe('succeeded');
    expect(r.summary).toContain('配方 example-checkin');
    expect(r.summary).toContain('+3');
    const s = browser.sessions[0]!;
    expect(s.filled.map((f) => f.value)).toEqual([USER, PW]);
    expect(s.actions).toEqual(['点击登录按钮', '现在是否已登录（只用一句话回答）', '点击签到；如果今天已签到，说明已签到']);
    const all = core.rawBodies.join('\n') + logs.join('\n');
    expect(all).not.toContain(PW);
    expect(all).not.toContain(USER);
  });

  it('配方检查没通过：退回通用处理器，仍完成任务', async () => {
    const { browser } = start({ actReplies: { 是否已登录: '没有', 签到: '通用办法签到成功' } }, example);
    core.secrets.set('s1:username', USER);
    core.secrets.set('s1:password', PW);
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/', secrets });
    await core.waitFor(() => core.results.has(t.id));
    const r = core.results.get(t.id)!;
    expect(r.status).toBe('succeeded');
    expect(r.summary).toContain('通用办法签到成功');
    expect(core.progress.filter((p) => p.taskId === t.id).map((p) => p.body.stage)).toContain('fallback');
    expect(browser.sessions[0]!.closed).toBe(true);
  });

  it('onFail=fail：配方失败直接失败，不兜底', async () => {
    const rec = { recipes: [{ ...example.recipes[0], onFail: 'fail' }] };
    start({ actReplies: { 是否已登录: '没有' } }, rec);
    core.secrets.set('s1:username', USER);
    core.secrets.set('s1:password', PW);
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/', secrets });
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('RECIPE_FAILED');
  });

  it('配方里遇验证码照样推接管卡；取消不兜底', async () => {
    start({ blockers: [{ reason: 'captcha', message: '滑块' }], actReplies: { 是否已登录: '已登录' } }, example);
    core.secrets.set('s1:username', USER);
    core.secrets.set('s1:password', PW);
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/', secrets });
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id, 'cancelled');
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('cancelled');
    expect(core.progress.filter((p) => p.taskId === t.id).map((p) => p.body.stage)).not.toContain('fallback');
  });

  it('遇验证码：先 handOff 把窗口交给所有者，再推接管卡，处理完继续', async () => {
    const { browser } = start({ blockers: [{ reason: 'captcha', message: '滑块' }, null], actReplies: { 是否已登录: '已登录' } }, example);
    core.secrets.set('s1:username', USER);
    core.secrets.set('s1:password', PW);
    const t = core.enqueue({ kind: 'checkin', site: 'https://example.com/', secrets });
    await core.waitFor(() => core.takeovers.size > 0);
    expect(browser.sessions[0]!.handOffs).toBe(1);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.status).toBe('succeeded');
  });

  it('配方里的 goto 跳出白名单：失败为 NOT_ALLOWED，不兜底', async () => {
    const rec = { recipes: [{ id: 'bad', site: 'example.com', kind: 'browse', steps: [{ do: 'goto', url: 'https://evil.net/' }] }] };
    start({}, rec);
    const t = core.enqueue({ kind: 'browse', site: 'https://example.com/' });
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NOT_ALLOWED');
  });

  it('没有命中配方的任务走通用处理器', async () => {
    start({ actReplies: { 签到: '通用签到' } }, example);
    const t = core.enqueue({ kind: 'checkin', site: 'https://other.example.com/' });
    // 不在白名单 → NOT_ALLOWED，证明没走配方
    await core.waitFor(() => core.takeovers.size > 0);
    core.resolveTakeover(t.id);
    await core.waitFor(() => core.results.has(t.id));
    expect(core.results.get(t.id)!.error?.code).toBe('NOT_ALLOWED');
  });
});
