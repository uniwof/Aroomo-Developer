/**
 * #365 执行员公网通路（负责人裁定方向 1a）的越权反向测试：
 *  - 路径变形：上游（Core 和 LobeHub）收到次数 = 0，不只看状态码；
 *  - 上游收到的请求头集合 = 白名单（完全一致）；响应去 Set-Cookie；
 *  - Access JWT 逐项反向用例；鉴权前按 IP 限速；请求体上限；未配置时整条关闭；凭据不进日志和错误。
 */
import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createShellServer, type ShellDeps } from '../src/server.js';
import { allowAll } from '../src/session.js';
import { executorPathOk, isExecutorCandidate } from '../src/executor-gate.js';

const TEAM = 'aroomo-test.cloudflareaccess.com';
const AUD = 'aud-executor-staging-0123';
const CLIENT_ID = 'expected-client-id.access';
const DEVICE = 'Bearer arc_device_token_placeholder_0123456789';
const CF_SECRET = 'cf-client-secret-placeholder-abcdef0123456789';
const NOW = 1_800_000_000_000;

const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...(keyA.publicKey.export({ format: 'jwk' }) as object), kid: 'kid-a', alg: 'RS256', use: 'sig' }] };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: KeyObject = keyA.privateKey): string {
  const h = b64({ alg: 'RS256', kid: 'kid-a', typ: 'JWT', ...header });
  const nowSec = Math.floor(NOW / 1000);
  const p = b64({ iss: `https://${TEAM}`, aud: [AUD], exp: nowSec + 300, iat: nowSec - 5, nbf: nowSec - 5, common_name: CLIENT_ID, sub: '', type: 'app', ...claims });
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url');
  return `${h}.${p}.${s}`;
}
const GOOD_JWT = jwt();

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const coreSeen: Seen[] = [];
const lobeSeen: string[] = [];
let core: Server;
let lobe: Server;
let coreUrl = '';
let lobeUrl = '';
const servers: Server[] = [];

const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

async function makeShell(extra: Record<string, string> = {}, opts: { noAccess?: boolean; deps?: ShellDeps } = {}): Promise<string> {
  const env: Record<string, string> = {
    SHELL_AUTH: 'core-session',
    CORE_UPSTREAM: coreUrl,
    LOBE_UPSTREAM: lobeUrl,
    CORE_OWNER_TOKEN: 'placeholder-owner-token-0123456789abcdef',
    SHELL_OWNER_EMAIL: 'owner@example.com',
    SHELL_CLIENT_IP_HEADER: 'cf-connecting-ip',
    ...(opts.noAccess ? {} : { SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN: TEAM, SHELL_EXECUTOR_ACCESS_AUD: AUD, SHELL_EXECUTOR_ACCESS_CLIENT_ID: CLIENT_ID }),
    ...extra,
  };
  const s = createShellServer(loadConfig(env), { fetchJwks: async () => jwks, now: () => NOW, ...opts.deps });
  servers.push(s);
  return listen(s);
}

/** 原样发出请求目标（不经 URL 规整） */
function raw(base: string, path: string, headers: Record<string, string> = {}, method = 'POST', body = '{"deviceName":"pc","platform":"win32","version":"0.1.0"}') {
  const u = new URL(base);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers: method === 'GET' ? headers : { 'content-type': 'application/json', ...headers } }, (res) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', reject);
    if (method !== 'GET') req.write(body);
    req.end();
  });
}

/** 走 TCP 原样写请求行（http.request 会拒绝控制字符） */
function rawSocket(base: string, requestLine: string) {
  const u = new URL(base);
  return new Promise<string>((resolve) => {
    const s = net.connect(Number(u.port), u.hostname, () => {
      s.write(`${requestLine}\r\nHost: x\r\ncf-access-jwt-assertion: ${GOOD_JWT}\r\nauthorization: ${DEVICE}\r\nconnection: close\r\n\r\n`);
    });
    let out = '';
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
  });
}

const okHeaders = (over: Record<string, string> = {}) => ({ 'cf-access-jwt-assertion': GOOD_JWT, authorization: DEVICE, accept: 'application/json', ...over });

beforeAll(async () => {
  core = http.createServer((req, res) => {
    const c: Buffer[] = [];
    req.on('data', (d: Buffer) => c.push(d));
    req.on('end', () => {
      coreSeen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(c).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'aroomo_session=evil; Path=/' });
      res.end('{"executorId":"e1"}');
    });
  });
  coreUrl = await listen(core);
  lobe = http.createServer((req, res) => {
    lobeSeen.push(`${req.method} ${req.url}`);
    res.writeHead(404);
    res.end('lobehub_stopped');
  });
  lobeUrl = await listen(lobe);
});

afterAll(async () => {
  for (const s of [...servers, core, lobe]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

beforeEach(() => {
  coreSeen.length = 0;
  lobeSeen.length = 0;
});

describe('#365 执行员通路：放行', () => {
  let base = '';
  beforeAll(async () => {
    base = await makeShell();
  });

  it('正确的 Access JWT + 设备令牌 + 正常路径：Core 恰好收到 1 次，原样路径，响应去掉 Set-Cookie', async () => {
    const r = await raw(base, '/api/executor/hello', okHeaders());
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(coreSeen).toHaveLength(1);
    expect(lobeSeen).toHaveLength(0);
    expect(coreSeen[0]!.url).toBe('/api/executor/hello');
    expect(coreSeen[0]!.method).toBe('POST');
    expect(JSON.parse(coreSeen[0]!.body)).toMatchObject({ deviceName: 'pc' });
  });

  it('上游收到的请求头集合与白名单完全一致：Cookie、CF 两个头、JWT、客户端 X-Forwarded-*、身份覆盖头全部去掉', async () => {
    const r = await raw(
      base,
      '/api/executor/tasks/claim?x=1',
      okHeaders({
        cookie: 'aroomo_session=abc; other=1',
        'cf-access-client-id': CLIENT_ID,
        'cf-access-client-secret': CF_SECRET,
        'cf-access-authenticated-user-email': 'owner@example.com',
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-real-ip': '6.6.6.6',
        forwarded: 'for=6.6.6.6',
        'x-aroomo-request': '1',
        'x-aroomo-executor': 'e1',
        'x-aroomo-user': 'owner',
        'x-user-id': 'owner',
        'x-original-url': '/api/users',
        'x-http-method-override': 'DELETE',
        'user-agent': 'aroomo-executor/0.1.0',
        origin: 'https://evil.example',
        referer: 'https://evil.example/',
      }),
    );
    expect(r.status).toBe(200);
    expect(coreSeen).toHaveLength(1);
    const h = coreSeen[0]!.headers;
    expect(Object.keys(h).sort()).toEqual(['accept', 'authorization', 'connection', 'content-length', 'content-type', 'host', 'x-forwarded-for', 'x-real-ip']);
    expect(h.authorization).toBe(DEVICE);
    // 来源 IP 由 Shell 自己算（直连方可信时取 cf-connecting-ip），不用客户端的 x-forwarded-for / x-real-ip
    expect(h['x-forwarded-for']).toBe('203.0.113.7');
    expect(h['x-real-ip']).toBe('203.0.113.7');
    expect(coreSeen[0]!.url).toBe('/api/executor/tasks/claim?x=1');
  });

  it('GET（接管长轮询）也放行，不带请求体', async () => {
    const r = await raw(base, '/api/executor/tasks/00000000-0000-4000-8000-000000000000/takeover/t1?waitSec=1', okHeaders(), 'GET');
    expect(r.status).toBe(200);
    expect(coreSeen).toHaveLength(1);
    expect(Object.keys(coreSeen[0]!.headers).sort()).toEqual(['accept', 'authorization', 'connection', 'host', 'x-forwarded-for', 'x-real-ip']);
  });
});

describe('#365 路径变形：一律拒绝，Core 与 LobeHub 收到次数 = 0', () => {
  let base = '';
  beforeAll(async () => {
    base = await makeShell();
  });
  const bad = [
    '/api/executor/../users',
    '/api/executor/./hello',
    '/api/executor/hello/..',
    '/api/executor/%2e%2e/users',
    '/api/executor/%2E%2E/users',
    '/api/executor/.%2e/users',
    '/api/executor/%2e/hello',
    '/api/executor/x%2fy',
    '/api/executor/x%2Fy',
    '/api/executor/x%5cy',
    '/api/executor/x%5Cy',
    '/api/executor//hello',
    '/api/executor/x\\y',
    '/api//executor/hello',
    '//api/executor/hello',
    '/api/%65xecutor/hello',
    '/API/executor/hello',
    '/api/Executor/hello',
    '/x/../api/executor/hello',
    '/api/executor',
    '/api/executor/hello%00',
    '/api/executor/hello%0a',
    '/api/executor/hello%7F',
    '/api/executor/hello?q=%0d%0a',
  ];
  for (const p of bad) {
    it(`拒绝 ${p}`, async () => {
      const r = await raw(base, p, okHeaders());
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(coreSeen).toHaveLength(0);
      expect(lobeSeen).toHaveLength(0);
      expect(r.body).not.toContain(GOOD_JWT);
    });
  }

  it('原始请求行里带控制字符（TAB）/ 非 ASCII：拒绝，上游 0 次', async () => {
    for (const line of ['GET /api/executor/he\tllo HTTP/1.1', 'GET /api/executor/\u00e9 HTTP/1.1']) {
      const out = await rawSocket(base, line);
      expect(out.startsWith('HTTP/1.1 4')).toBe(true);
    }
    expect(coreSeen).toHaveLength(0);
    expect(lobeSeen).toHaveLength(0);
  });

  it('WebSocket 升级到执行员路径：直接断开，LobeHub 收不到', async () => {
    const out = await rawSocket(base, 'GET /api/executor/hello HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade');
    expect(out).toBe('');
    expect(coreSeen).toHaveLength(0);
    expect(lobeSeen).toHaveLength(0);
  });

  it('不在白名单的方法（PUT / DELETE）：405，上游 0 次', async () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) expect((await raw(base, '/api/executor/hello', okHeaders(), m)).status).toBe(405);
    expect(coreSeen).toHaveLength(0);
  });

  it('纯函数：executorPathOk / isExecutorCandidate', () => {
    expect(executorPathOk('/api/executor/hello')).toBe(true);
    expect(executorPathOk('/api/executor/tasks/abc/takeover/t1?waitSec=25')).toBe(true);
    for (const p of bad) expect(executorPathOk(p)).toBe(false);
    expect(isExecutorCandidate('/api/%65xecutor/x', '/api/executor/x')).toBe(true);
    expect(isExecutorCandidate('/api/chat/stream', '/api/chat/stream')).toBe(false);
    for (const p of HUMAN_ROUTES) expect(isExecutorCandidate(p, p), p).toBe(false);
  });
});

/** 人用的接口：名字里带 executor，但不是 /api/executor/ 这一段，必须照原分支走（#376 M1 正向对照） */
const HUMAN_ROUTES = ['/api/executors', '/api/executor-allowlist', '/aroomo/api/executors', '/aroomo/api/executor-allowlist'];

describe('#376 M1 正向对照：人用的执行员管理接口不进闸门', () => {
  for (const noAccess of [false, true]) {
    for (const p of HUMAN_ROUTES) {
      it(`${noAccess ? '未配' : '已配'} Access：GET ${p} 照原分支转发（/aroomo/api → Core，其余 → LobeHub）`, async () => {
        const b = await makeShell({}, { noAccess, deps: { session: allowAll } });
        const r = await raw(b, p, {}, 'GET');
        expect(r.body).not.toMatch(/NOT_FOUND|BAD_PATH|ACCESS_DENIED|找不到/);
        if (p.startsWith('/aroomo/api/')) {
          // 和同分支的普通接口（/aroomo/api/memory）结果完全一样：证明走的是 /aroomo/api 分支，不是执行员闸门
          const ctl = await raw(b, '/aroomo/api/memory', {}, 'GET');
          expect([r.status, JSON.parse(r.body).error?.code]).toEqual([ctl.status, JSON.parse(ctl.body).error?.code]);
          expect(lobeSeen).toHaveLength(0);
        } else {
          expect(lobeSeen).toEqual([`GET ${p}`]);
          expect(coreSeen).toHaveLength(0);
        }
      });
    }
  }
});

describe('#365 Access JWT 逐项反向（Shell 自己验，失败即关闭）', () => {
  let base = '';
  beforeAll(async () => {
    base = await makeShell();
  });
  const nowSec = Math.floor(NOW / 1000);
  const cases: [string, Record<string, string>][] = [
    ['缺 JWT 头', { authorization: DEVICE }],
    ['空 JWT', okHeaders({ 'cf-access-jwt-assertion': '' })],
    ['乱码', okHeaders({ 'cf-access-jwt-assertion': 'not.a.jwt' })],
    ['错签名（别的私钥，同 kid）', okHeaders({ 'cf-access-jwt-assertion': jwt({}, {}, keyB.privateKey) })],
    ['签名被篡改（改 claims 不重签）', okHeaders({ 'cf-access-jwt-assertion': (() => { const [h, , s] = GOOD_JWT.split('.'); return `${h}.${b64({ iss: `https://${TEAM}`, aud: [AUD], exp: nowSec + 300, common_name: 'attacker' })}.${s}`; })() })],
    ['错 aud', okHeaders({ 'cf-access-jwt-assertion': jwt({ aud: ['aud-owner-only-app'] }) })],
    ['aud 缺失', okHeaders({ 'cf-access-jwt-assertion': jwt({ aud: undefined }) })],
    ['错 iss', okHeaders({ 'cf-access-jwt-assertion': jwt({ iss: 'https://evil.cloudflareaccess.com' }) })],
    ['iss 不带 https', okHeaders({ 'cf-access-jwt-assertion': jwt({ iss: TEAM }) })],
    ['过期', okHeaders({ 'cf-access-jwt-assertion': jwt({ exp: nowSec - 1 }) })],
    ['exp 缺失', okHeaders({ 'cf-access-jwt-assertion': jwt({ exp: undefined }) })],
    ['nbf 在未来', okHeaders({ 'cf-access-jwt-assertion': jwt({ nbf: nowSec + 3600 }) })],
    ['错 common_name（别的 service token）', okHeaders({ 'cf-access-jwt-assertion': jwt({ common_name: 'other-client-id.access' }) })],
    ['common_name 缺失（所有者浏览器登录的 JWT）', okHeaders({ 'cf-access-jwt-assertion': jwt({ common_name: undefined, email: 'owner@example.com', type: 'app' }) })],
    ['alg=none', okHeaders({ 'cf-access-jwt-assertion': `${b64({ alg: 'none', kid: 'kid-a' })}.${GOOD_JWT.split('.')[1]}.` })],
    ['alg=HS256', okHeaders({ 'cf-access-jwt-assertion': jwt({}, { alg: 'HS256' }) })],
    ['不认识的 kid', okHeaders({ 'cf-access-jwt-assertion': jwt({}, { kid: 'kid-x' }) })],
    ['只带 CF 两个头不带 JWT（绕过 Access 直连 Shell）', { authorization: DEVICE, 'cf-access-client-id': CLIENT_ID, 'cf-access-client-secret': CF_SECRET }],
  ];
  for (const [name, headers] of cases) {
    it(`${name} → 403，Core 0 次`, async () => {
      const r = await raw(base, '/api/executor/hello', headers);
      expect(r.status).toBe(403);
      expect(coreSeen).toHaveLength(0);
      expect(lobeSeen).toHaveLength(0);
      expect(r.body).not.toContain(CF_SECRET);
      expect(r.body).not.toContain('arc_device');
    });
  }

  it('取不到 Access 公钥：全部拒绝（失败即关闭）', async () => {
    const s = createShellServer(
      loadConfig({ SHELL_AUTH: 'core-session', CORE_UPSTREAM: coreUrl, LOBE_UPSTREAM: lobeUrl, SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN: TEAM, SHELL_EXECUTOR_ACCESS_AUD: AUD, SHELL_EXECUTOR_ACCESS_CLIENT_ID: CLIENT_ID }),
      { fetchJwks: async () => { throw new Error('down'); }, now: () => NOW },
    );
    servers.push(s);
    const b = await listen(s);
    expect((await raw(b, '/api/executor/hello', okHeaders())).status).toBe(403);
    expect(coreSeen).toHaveLength(0);
  });
});

describe('#365 未配置 / 限速 / 请求体上限 / 配置校验', () => {
  it('没配 Access 三项：执行员路径整条关闭（404），Core 与 LobeHub 都收不到', async () => {
    const b = await makeShell({}, { noAccess: true });
    const r = await raw(b, '/api/executor/hello', okHeaders());
    expect(r.status).toBe(404);
    expect(coreSeen).toHaveLength(0);
    expect(lobeSeen).toHaveLength(0);
  });

  it('鉴权前按 IP 限速：超过每分钟上限即 429（不带 JWT 的猜测也计数）', async () => {
    const b = await makeShell({ SHELL_EXECUTOR_RATE_PER_MIN: '3' });
    const ip = { 'cf-connecting-ip': '198.51.100.9' };
    expect((await raw(b, '/api/executor/hello', { ...ip })).status).toBe(403);
    expect((await raw(b, '/api/executor/hello', { ...ip })).status).toBe(403);
    expect((await raw(b, '/api/executor/hello', okHeaders(ip))).status).toBe(200);
    expect((await raw(b, '/api/executor/hello', okHeaders(ip))).status).toBe(429);
    expect(coreSeen).toHaveLength(1);
    // 别的 IP 不受影响
    expect((await raw(b, '/api/executor/hello', okHeaders({ 'cf-connecting-ip': '198.51.100.10' }))).status).toBe(200);
  });

  it('请求体超过 1 MiB：413，Core 0 次（content-length 声明超限、或分块实际超限）', async () => {
    const b = await makeShell();
    const big = 'x'.repeat(1024 * 1024 + 10);
    expect((await raw(b, '/api/executor/tasks/x/result', okHeaders(), 'POST', big)).status).toBe(413);
    expect((await raw(b, '/api/executor/tasks/x/result', okHeaders({ 'content-length': 'abc' }), 'POST', '{}').catch(() => ({ status: 400 }))).status).toBeGreaterThanOrEqual(400);
    const chunked = await new Promise<number>((resolve) => {
      const u = new URL(b);
      const req = http.request({ host: u.hostname, port: u.port, path: '/api/executor/tasks/x/result', method: 'POST', headers: okHeaders({ 'transfer-encoding': 'chunked' }) }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(0));
      req.write(big.slice(0, 600_000));
      req.write(big.slice(600_000));
      req.end();
    });
    expect([0, 413]).toContain(chunked);
    expect(coreSeen).toHaveLength(0);
  });

  it('三项只设一部分 / 团队域名格式不对：拒绝启动', () => {
    expect(() => loadConfig({ SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN: TEAM })).toThrow(ConfigError);
    expect(() => loadConfig({ SHELL_EXECUTOR_ACCESS_AUD: AUD, SHELL_EXECUTOR_ACCESS_CLIENT_ID: CLIENT_ID })).toThrow(ConfigError);
    expect(() => loadConfig({ SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN: `https://${TEAM}`, SHELL_EXECUTOR_ACCESS_AUD: AUD, SHELL_EXECUTOR_ACCESS_CLIENT_ID: CLIENT_ID })).toThrow(ConfigError);
    expect(() => loadConfig({ SHELL_EXECUTOR_RATE_PER_MIN: '0' })).toThrow(ConfigError);
    expect(loadConfig({}).executorAccess).toBeUndefined();
  });
});

describe('#365 泄露检查：凭据不进日志和错误', () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    const w = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array, ...rest: unknown[]) => {
      logged.push(String(c));
      return (w as (...x: unknown[]) => boolean)(c, ...rest);
    }) as typeof process.stderr.write);
  });
  afterEach(() => vi.restoreAllMocks());

  it('放行、被拒、上游断开：日志和响应里都没有 JWT、CF Secret、设备令牌', async () => {
    const b = await makeShell();
    const bodies: string[] = [];
    bodies.push((await raw(b, '/api/executor/hello', okHeaders({ 'cf-access-client-secret': CF_SECRET }))).body);
    bodies.push((await raw(b, '/api/executor/hello', okHeaders({ 'cf-access-jwt-assertion': jwt({ exp: 1 }), 'cf-access-client-secret': CF_SECRET }))).body);
    bodies.push((await raw(b, '/api/executor/../x', okHeaders({ 'cf-access-client-secret': CF_SECRET }))).body);
    const dead = createShellServer(
      loadConfig({ SHELL_AUTH: 'core-session', CORE_UPSTREAM: 'http://127.0.0.1:1', LOBE_UPSTREAM: lobeUrl, SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN: TEAM, SHELL_EXECUTOR_ACCESS_AUD: AUD, SHELL_EXECUTOR_ACCESS_CLIENT_ID: CLIENT_ID }),
      { fetchJwks: async () => jwks, now: () => NOW },
    );
    servers.push(dead);
    const db = await listen(dead);
    const r = await raw(db, '/api/executor/hello', okHeaders({ 'cf-access-client-secret': CF_SECRET }));
    expect(r.status).toBe(502);
    bodies.push(r.body);
    for (const s of [...bodies, ...logged]) {
      expect(s).not.toContain(GOOD_JWT);
      expect(s).not.toContain(CF_SECRET);
      expect(s).not.toContain('arc_device_token');
    }
    expect(coreSeen.every((c) => !JSON.stringify(c.headers).includes(CF_SECRET) && !JSON.stringify(c.headers).includes(GOOD_JWT))).toBe(true);
  });
});
