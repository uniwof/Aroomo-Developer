/**
 * Aroomo Shell：同源入口。浏览器只访问这里；
 *   /aroomo/static/*   Aroomo 的静态资源（不需要登录，不含任何秘密）
 *   /aroomo/api/*      → Core /api/*（要求已登录 LobeHub；由这里附加主人令牌，浏览器永远拿不到令牌）
 *   /aroomo、/aroomo/* Aroomo 页面（成员、Key 与接入、收件箱、收藏、设置）
 *   其余               → 官方 LobeHub（HTML 文档注入 Aroomo 的 CSS / JS；其他原样转发，含流式输出与 WebSocket）
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import zlib from 'node:zlib';
import type { ShellConfig } from './config.js';
import { transformHtml } from './html.js';
import { decideNavigation, isBlockedApi } from './rules.js';
import { allowAll, LobeSessionChecker, type SessionChecker } from './session.js';
import { AUTOLOGIN_MARK, LobeLocalAutoLogin, safeCallback, type AutoLogin } from './autologin.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_HTML_BYTES = 8 * 1024 * 1024;

/** 上游品牌图片路径 → Aroomo 静态文件名（没有就返回 null） */
export function brandAsset(p: string): string | null {
  if (p === '/avatars/lobe-ai.png') return 'avatar.png';
  const m = /^\/app-icons\/icon-(192x192|512x512)(\.maskable)?\.png$/.exec(p);
  if (m) return `icon-${m[2] ? 'maskable-' : ''}${m[1] === '192x192' ? '192' : '512'}.png`;
  if (p === '/icons/icon-192x192.png') return 'icon-192.png';
  if (p === '/icons/icon-512x512.png') return 'icon-512.png';
  return null;
}

/** LobeHub 还没起来时的「正在准备」页：Aroomo Logo + 珊瑚色，自动刷新（不靠 JS 也能用） */
export const PREPARING_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="5">
<meta name="theme-color" content="#ff7f50"><title>Aroomo 正在准备</title>
<link rel="icon" href="/aroomo/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/aroomo/static/preparing.css">
</head><body><main role="status" aria-live="polite">
<img class="logo" src="/aroomo/static/logo.svg" alt="Aroomo" width="72" height="72">
<h1>Aroomo 正在准备</h1><p>后台正在启动，好了会自动打开。第一次可能需要几分钟。</p>
<div class="bar" aria-hidden="true"><span></span></div></main></body></html>`;

export interface ShellDeps {
  session?: SessionChecker;
  autoLogin?: AutoLogin;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

function forwardHeaders(req: IncomingMessage, extra: Record<string, string | undefined> = {}, drop: string[] = []) {
  const h: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || drop.includes(k)) continue;
    h[k] = v;
  }
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  h['x-forwarded-proto'] = proto;
  if (req.headers.host && !h['x-forwarded-host']) h['x-forwarded-host'] = req.headers.host;
  const fwd = req.headers['x-forwarded-for'];
  const ip = req.socket.remoteAddress ?? '';
  h['x-forwarded-for'] = fwd ? `${fwd}, ${ip}` : ip;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return h;
}

function responseHeaders(up: IncomingMessage, drop: string[] = []) {
  const h: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(up.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || drop.includes(k)) continue;
    h[k] = v;
  }
  return h;
}

function hasCookie(cookieHeader: string | undefined, name: string): boolean {
  return (cookieHeader ?? '').split(';').some((c) => c.trim().startsWith(`${name}=`));
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html');
}

function decode(buf: Buffer, enc: string | undefined): Buffer {
  switch ((enc ?? '').toLowerCase()) {
    case 'gzip':
      return zlib.gunzipSync(buf);
    case 'br':
      return zlib.brotliDecompressSync(buf);
    case 'deflate':
      return zlib.inflateSync(buf);
    default:
      return buf;
  }
}

/** 同源校验：改动类请求必须带自定义头（跨站页面无法在不经 CORS 预检的情况下加），Origin 若有必须同源 */
function csrfOk(req: IncomingMessage): boolean {
  const m = req.method ?? 'GET';
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (req.headers['x-aroomo-request'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const xfh = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim();
  return host === req.headers.host || (Boolean(xfh) && host === xfh);
}

export function createShellServer(cfg: ShellConfig, deps: ShellDeps = {}) {
  const session: SessionChecker =
    deps.session ?? (cfg.auth === 'off' ? allowAll : new LobeSessionChecker(cfg.lobeUpstream, cfg.sessionCacheMs));
  const autoLogin: AutoLogin | undefined =
    deps.autoLogin ?? (cfg.localOwner ? new LobeLocalAutoLogin(cfg.lobeUpstream, cfg.localOwner) : undefined);
  const staticRoot = path.resolve(cfg.publicDir, 'static');
  const appHtml = path.resolve(cfg.publicDir, 'app.html');

  const clientFor = (u: URL) => (u.protocol === 'https:' ? https : http);

  async function serveFile(res: ServerResponse, file: string, cache: string, method = 'GET') {
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'content-length': String(st.size),
        'cache-control': cache,
        'x-content-type-options': 'nosniff',
      });
      if (method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '找不到' } });
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, rel: string) {
    const file = path.resolve(staticRoot, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
    if (!file.startsWith(staticRoot + path.sep)) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '找不到' } });
    return serveFile(res, file, 'public, max-age=300', req.method);
  }

  function proxyCore(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!cfg.coreOwnerToken) {
      return sendJson(res, 503, { error: { code: 'CORE_NOT_CONFIGURED', message: 'Aroomo 后台还没有配置好（缺少主人令牌）' } });
    }
    const target = new URL('/api' + url.pathname.slice('/aroomo/api'.length) + url.search, cfg.coreUpstream);
    const headers = forwardHeaders(
      req,
      // 浏览器不能自己带令牌；Cookie 不发给 Core。Cloudflare Access 的 JWT 头保留（凭据操作重新验证要用，CONFIRM-CARD §4）
      { authorization: `Bearer ${cfg.coreOwnerToken}`, cookie: undefined, host: target.host, 'x-aroomo-request': undefined },
      [],
    );
    const up = clientFor(target).request(target, { method: req.method, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...responseHeaders(upRes, ['set-cookie']), 'cache-control': 'no-store' });
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { error: { code: 'CORE_UNAVAILABLE', message: 'Aroomo 后台暂时不可用，请稍后再试' } });
      else res.destroy();
    });
    req.pipe(up);
  }

  function proxyLobe(req: IncomingMessage, res: ServerResponse, url: URL) {
    const html = wantsHtml(req);
    const cookie = req.headers.cookie;
    const setLocale = !hasCookie(cookie, 'LOBE_LOCALE');
    const extra: Record<string, string | undefined> = {};
    if (html) extra['accept-encoding'] = 'identity';
    if (setLocale) {
      extra.cookie = [cookie, `LOBE_LOCALE=${cfg.defaultLocale}`].filter(Boolean).join('; ');
      extra['accept-language'] = `${cfg.defaultLocale},zh;q=0.9`;
    }
    const target = new URL(url.pathname + url.search, cfg.lobeUpstream);
    const up = clientFor(target).request(target, { method: req.method, headers: forwardHeaders(req, extra) }, (upRes) => {
      const ct = String(upRes.headers['content-type'] ?? '');
      const headers = responseHeaders(upRes);
      if (setLocale) {
        const sc = headers['set-cookie'];
        const mine = `LOBE_LOCALE=${cfg.defaultLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
        headers['set-cookie'] = Array.isArray(sc) ? [...sc, mine] : sc ? [sc, mine] : [mine];
      }
      if (!html || !ct.includes('text/html') || req.method === 'HEAD') {
        res.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      upRes.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_HTML_BYTES) chunks.push(c);
      });
      upRes.on('end', () => {
        if (size > MAX_HTML_BYTES) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('页面过大');
        }
        let body: string;
        try {
          body = transformHtml(decode(Buffer.concat(chunks), upRes.headers['content-encoding'] as string | undefined).toString('utf8'));
        } catch {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('页面解析失败');
        }
        delete headers['content-length'];
        delete headers['content-encoding'];
        delete headers['etag'];
        headers['cache-control'] = 'no-store';
        const buf = Buffer.from(body, 'utf8');
        headers['content-length'] = String(buf.length);
        res.writeHead(upRes.statusCode ?? 200, headers);
        res.end(buf);
      });
      upRes.on('error', () => res.destroy());
    });
    up.on('error', () => {
      if (!res.headersSent) {
        if (html) {
          res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' });
          res.end(PREPARING_HTML);
        } else {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Aroomo 正在启动，请稍后刷新');
        }
      } else res.destroy();
    });
    req.pipe(up);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://shell.local');
    const p = url.pathname;

    if (p === '/aroomo/healthz') return sendJson(res, 200, { status: 'ok', service: 'aroomo-shell' });
    if (p.startsWith('/aroomo/static/')) return serveStatic(req, res, p.slice('/aroomo/static/'.length));

    // 品牌图标（上游路径也拦下，避免浏览器缓存的旧链接仍显示 LobeHub 图标）
    if (/^\/favicon[^/]*\.ico$/.test(p)) return serveFile(res, path.join(staticRoot, 'favicon.ico'), 'public, max-age=86400', req.method);
    if (p === '/apple-touch-icon.png') return serveFile(res, path.join(staticRoot, 'apple-touch-icon.png'), 'public, max-age=86400', req.method);
    if (p === '/manifest.json' || p === '/manifest.webmanifest') return serveFile(res, path.join(staticRoot, 'manifest.json'), 'public, max-age=300', req.method);
    // 上游的 PWA 图标、默认助理头像（Lobe AI 吉祥物）→ Aroomo 图标（文件是官方镜像里的，不改，只在入口拦下）
    const brandFile = brandAsset(p);
    if (brandFile) return serveFile(res, path.join(staticRoot, brandFile), 'public, max-age=86400', req.method);

    // Windows 独立版（D78）：没登录的页面请求，替本机主人登录后跳回原页面（登录页 / 注册页跳到 callbackUrl）
    if (autoLogin && wantsHtml(req) && !hasCookie(req.headers.cookie, AUTOLOGIN_MARK) && !(await session.check(req.headers.cookie))) {
      const cookies = await autoLogin.login();
      if (cookies) {
        const onAuthPage = /^\/(signin|signup)(\/|$)/.test(p);
        const location = onAuthPage ? safeCallback(url.searchParams.get('callbackUrl')) : p + url.search;
        res.writeHead(302, {
          location,
          'set-cookie': [...cookies, `${AUTOLOGIN_MARK}=1; Path=/; Max-Age=30; HttpOnly; SameSite=Lax`],
          'cache-control': 'no-store',
        });
        return res.end();
      }
    }

    if (p === '/aroomo/api' || p.startsWith('/aroomo/api/')) {
      if (!csrfOk(req)) return sendJson(res, 403, { error: { code: 'CSRF', message: '请求来源不对' } });
      if (!(await session.check(req.headers.cookie))) return sendJson(res, 401, { error: { code: 'LOGIN_REQUIRED', message: '请先登录' } });
      return proxyCore(req, res, url);
    }

    if (p === '/aroomo' || p.startsWith('/aroomo/')) {
      if (!(await session.check(req.headers.cookie))) {
        res.writeHead(302, { location: `/signin?callbackUrl=${encodeURIComponent(p + url.search)}`, 'cache-control': 'no-store' });
        return res.end();
      }
      return serveFile(res, appHtml, 'no-store', req.method);
    }

    // D68：朗读接口禁用
    if (isBlockedApi(p)) return sendJson(res, 403, { error: { code: 'DISABLED', message: '朗读功能已关闭' } });

    if (wantsHtml(req)) {
      const d = decideNavigation(p);
      if (d.kind === 'redirect') {
        res.writeHead(302, { location: d.location, 'cache-control': 'no-store' });
        return res.end();
      }
    }
    return proxyLobe(req, res, url);
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://shell.local');
    if (url.pathname.startsWith('/aroomo/')) return socket.destroy();
    const target = new URL(url.pathname + url.search, cfg.lobeUpstream);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
    const up = clientFor(target).request(target, { method: req.method, headers });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
    });
    up.on('response', (r) => {
      socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`);
    });
    up.on('error', () => socket.destroy());
    up.end();
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: '内部错误' } });
      else res.destroy();
    });
  });
  server.on('upgrade', upgrade);
  // 流式回答可能很久：不设整体超时
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}
