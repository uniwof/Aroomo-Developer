/**
 * #365 执行员侧：CF-Access-Client-Id / Secret 两个头只发给 coreUrl 同源；redirect:'manual'，3xx 当错误；
 * Secret 不写明文配置（Windows DPAPI，其他系统环境变量）；status/doctor 探活走 /api/executor/hello；
 * 日志、错误里不出现 Secret 和设备令牌。
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cfSecretPath, cfSecretReader, CF_SECRET_ENV, saveCfSecret, setCfClientId, type PsRunner } from '../src/cf-access.js';
import { defaultConfig, parseConfig } from '../src/config.js';
import { renderDoctor, runDoctor } from '../src/doctor.js';
import { createLogger } from '../src/logger.js';
import { CoreError, HttpTransport, probeCore } from '../src/transport.js';

const CLIENT_ID = 'expected-client-id.access';
const SECRET = 'cf-secret-placeholder-0123456789abcdef';
const DEVICE = 'device-token-placeholder-0123456789';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}
let core: Server;
let other: Server;
let coreUrl = '';
let otherUrl = '';
const coreSeen: Seen[] = [];
const otherSeen: Seen[] = [];
let mode: 'ok' | 'redirect-other' | 'redirect-access' | 'forbidden' = 'ok';

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  other = createServer((req, res) => {
    otherSeen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"executorId":"evil"}');
  });
  otherUrl = await listen(other);
  core = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      coreSeen.push({ url: req.url ?? '', headers: req.headers });
      if (mode === 'redirect-other') {
        res.writeHead(307, { location: `${otherUrl}/api/executor/hello` });
        return res.end();
      }
      if (mode === 'redirect-access') {
        res.writeHead(302, { location: 'https://aroomo.cloudflareaccess.com/cdn-cgi/access/login/x' });
        return res.end();
      }
      if (mode === 'forbidden') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end('{"error":{"code":"ACCESS_DENIED","message":"没有通过访问校验"}}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"executorId":"e1","pollWaitSec":1,"leaseSec":30}');
    });
  });
  coreUrl = await listen(core);
});
afterAll(async () => {
  for (const s of [core, other]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
beforeEach(() => {
  coreSeen.length = 0;
  otherSeen.length = 0;
  mode = 'ok';
});

const hello = { deviceName: 'pc', platform: 'win32', version: '0.1.0', adapters: [], allowlistHash: 'h' };
const mk = (baseUrl = coreUrl, cf = true) =>
  new HttpTransport({ baseUrl, getToken: () => DEVICE, version: '0.1.0', timeoutMs: 3000, ...(cf ? { cfAccess: { clientId: CLIENT_ID, getSecret: () => SECRET } } : {}) });

describe('#365 HttpTransport + Cloudflare Access', () => {
  it('配了 cfAccess：请求 coreUrl 时带 CF 两个头和设备令牌', async () => {
    await mk().hello(hello);
    expect(coreSeen).toHaveLength(1);
    expect(coreSeen[0]!.url).toBe('/api/executor/hello');
    expect(coreSeen[0]!.headers['cf-access-client-id']).toBe(CLIENT_ID);
    expect(coreSeen[0]!.headers['cf-access-client-secret']).toBe(SECRET);
    expect(coreSeen[0]!.headers.authorization).toBe(`Bearer ${DEVICE}`);
  });

  it('没配 cfAccess：不带 CF 两个头', async () => {
    await mk(coreUrl, false).hello(hello);
    expect(coreSeen[0]!.headers['cf-access-client-id']).toBeUndefined();
    expect(coreSeen[0]!.headers['cf-access-client-secret']).toBeUndefined();
  });

  it('Core 返回 3xx 跳到别的源：不跟随（别的源 0 次），当错误；错误消息里没有 Secret / 令牌', async () => {
    mode = 'redirect-other';
    const e = await mk().hello(hello).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CoreError);
    expect((e as CoreError).code).toBe('REDIRECT');
    expect((e as CoreError).authFailed).toBe(true);
    expect((e as CoreError).retryable).toBe(false);
    expect(otherSeen).toHaveLength(0);
    expect(String((e as Error).message)).not.toContain(SECRET);
    expect(String((e as Error).message)).not.toContain(DEVICE);
  });

  it('Access 跳去登录页（302）：当错误，不跟随', async () => {
    mode = 'redirect-access';
    const e = (await mk().claim(0).catch((x: unknown) => x)) as CoreError;
    expect(e.code).toBe('REDIRECT');
    expect(coreSeen).toHaveLength(1);
  });

  it('同源判断按 origin：baseUrl 带路径也只发给同源', async () => {
    await mk(`${coreUrl}/`).hello(hello);
    expect(coreSeen[0]!.headers['cf-access-client-secret']).toBe(SECRET);
  });

  it('取不到 Secret：不发请求（不会只带设备令牌去撞 Access）', async () => {
    const t = new HttpTransport({ baseUrl: coreUrl, getToken: () => DEVICE, version: '0', cfAccess: { clientId: CLIENT_ID, getSecret: () => { throw new Error('没有 Cloudflare Access 密钥'); } } });
    await expect(t.hello(hello)).rejects.toThrow('没有 Cloudflare Access 密钥');
    expect(coreSeen).toHaveLength(0);
  });
});

describe('#365 探活走 /api/executor/hello（不是 /healthz）', () => {
  const cfg = { ...defaultConfig(mkdtempSync(join(tmpdir(), 'cfp-'))), coreUrl: '', deviceName: 'pc' };
  it('正常 → ok；探的是 /api/executor/hello，带 CF 两个头', async () => {
    const r = await probeCore(mk(), { ...cfg, coreUrl }, '0.1.0');
    expect(r.ok).toBe(true);
    expect(coreSeen.map((s) => s.url)).toEqual(['/api/executor/hello']);
    expect(coreSeen[0]!.headers['cf-access-client-id']).toBe(CLIENT_ID);
  });
  it('被 Access 拦（403 / 302）→ 不 ok，doctor 给出 Access 提示，文字里没有 Secret', async () => {
    mode = 'redirect-access';
    const r = await probeCore(mk(), { ...cfg, coreUrl }, '0.1.0');
    expect(r).toMatchObject({ ok: false, status: 302 });
    const dir = mkdtempSync(join(tmpdir(), 'cfd-'));
    const c = defaultConfig(dir);
    writeFileSync(c.tokenFile, DEVICE);
    const [text, code] = renderDoctor(
      await runDoctor(c, { nodeVersion: '22.4.0', coreHealth: async () => r, ego: async () => ({ code: 0, stdout: '' }), npxOk: async () => true }),
    );
    expect(code).toBe(2);
    expect(text).toContain('Cloudflare Access');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(DEVICE);
    mode = 'forbidden';
    expect(await probeCore(mk(), { ...cfg, coreUrl }, '0.1.0')).toMatchObject({ ok: false, status: 403 });
  });
});

describe('#365 Secret 不写明文配置', () => {
  const fakePs: PsRunner = (script, input) => (script.includes('::Protect(') ? `ENC(${Buffer.from(input).toString('base64')})` : Buffer.from(input.slice(4, -1), 'base64').toString('utf8'));

  it('config.json 里出现 secret 字段：拒绝加载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfc-'));
    expect(() => parseConfig({ cfAccess: { clientId: CLIENT_ID, clientSecret: SECRET } }, dir)).toThrow('不要把 Cloudflare Access 密钥写进 config.json');
    expect(() => parseConfig({ cfAccess: { clientId: '' } }, dir)).toThrow();
    expect(parseConfig({ cfAccess: { clientId: CLIENT_ID } }, dir).cfAccess).toEqual({ clientId: CLIENT_ID });
    expect(parseConfig({}, dir).cfAccess).toBeUndefined();
  });

  it('Windows：DPAPI 加密落盘，文件里没有明文；读回正确；config.json 只写 clientId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfw-'));
    const cfg = defaultConfig(dir);
    const file = cfSecretPath(cfg);
    saveCfSecret(file, `${SECRET}\n`, 'win32', fakePs);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(cfSecretReader(cfg, {}, 'win32', fakePs)()).toBe(SECRET);
    const cfgFile = join(dir, 'config.json');
    writeFileSync(cfgFile, JSON.stringify(cfg));
    setCfClientId(cfgFile, CLIENT_ID);
    const saved = readFileSync(cfgFile, 'utf8');
    expect(JSON.parse(saved).cfAccess).toEqual({ clientId: CLIENT_ID });
    expect(saved).not.toContain(SECRET);
  });

  it('非 Windows：不落盘，只认环境变量；都没有时报错且不含任何值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfl-'));
    const cfg = defaultConfig(dir);
    expect(() => saveCfSecret(cfSecretPath(cfg), SECRET, 'linux', fakePs)).toThrow(CF_SECRET_ENV);
    expect(cfSecretReader(cfg, { [CF_SECRET_ENV]: SECRET }, 'linux')()).toBe(SECRET);
    expect(() => cfSecretReader(cfg, {}, 'linux')()).toThrow(CF_SECRET_ENV);
  });

  it('DPAPI 失败：错误消息不带 Secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfe-'));
    const boom: PsRunner = () => {
      throw new Error(`powershell failed with ${SECRET}`);
    };
    let msg = '';
    try {
      saveCfSecret(cfSecretPath(defaultConfig(dir)), SECRET, 'win32', boom);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('DPAPI');
    expect(msg).not.toContain(SECRET);
  });
});

describe('#365 泄露检查：日志里没有 Secret / 设备令牌', () => {
  it('执行员日志即使被塞进头、错误对象，也不出现 Secret 和令牌值', async () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    mode = 'forbidden';
    const e = (await mk().hello(hello).catch((x: unknown) => x)) as CoreError;
    log.error('连不上', { status: e.status, code: e.code, message: e.message });
    mode = 'redirect-other';
    const e2 = (await mk().hello(hello).catch((x: unknown) => x)) as CoreError;
    log.warn('跳转', { code: e2.code, message: e2.message });
    for (const l of lines) {
      expect(l).not.toContain(SECRET);
      expect(l).not.toContain(DEVICE);
    }
    expect(lines).toHaveLength(2);
  });
});

/**
 * #376 M5：真 DPAPI 往返，不用替身。Windows CI（executor.yml windows-install 作业）设 AROOMO_REAL_DPAPI=1 实跑，
 * 并核对这条用例的结果是 passed（不是 skipped）；其他环境不设这个变量就不跑。
 * 设了变量却不在 Windows 上 → 直接失败（防止误以为跑过了）。
 */
describe.runIf(process.env.AROOMO_REAL_DPAPI === '1')('#376 真 DPAPI 往返（Windows CI 实跑）', () => {
  it('真 DPAPI：saveCfSecret 加密落盘 → cfSecretReader 解开，值一致；文件里没有明文；安装脚本存的那份也能解开', () => {
    expect(process.platform).toBe('win32');
    const dir = mkdtempSync(join(tmpdir(), 'aroomo-dpapi-'));
    const tokenFile = join(dir, 'device-token');
    const secret = `real-dpapi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    saveCfSecret(cfSecretPath({ tokenFile }), secret);
    expect(readFileSync(cfSecretPath({ tokenFile }), 'utf8')).not.toContain(secret);
    expect(cfSecretReader({ tokenFile }, {})()).toBe(secret);
    // 安装脚本（-BootstrapFile）存下的那份：CI 先跑安装脚本，再把它的 device-token 路径和期望值传进来
    const installed = process.env.AROOMO_REAL_DPAPI_TOKENFILE;
    const expected = process.env.AROOMO_REAL_DPAPI_EXPECT;
    expect(installed && expected, '没拿到安装脚本存的路径和期望值').toBeTruthy();
    expect(cfSecretReader({ tokenFile: installed! }, {})()).toBe(expected);
  });
});
