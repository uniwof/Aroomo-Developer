'use strict';
/**
 * 独立版收藏（Karakeep）的本机主人自动登录（D78：单一本机主人，不注册、不输入密码，信任 Windows 账户）。
 *
 * 和 Aroomo Shell 替 LobeHub 做的一样：Karakeep 0.34 也用 Better Auth。本文件在 Karakeep 前面放一个只听本机的
 * 透明转发（零依赖，不改 Karakeep 的任何文件，D69）：浏览器打开收藏页面又没有登录时，在本机替它调用
 *   POST /api/auth/sign-in/email；账号还不存在（第一次，第一个账号就是收藏的管理员）就 POST /api/auth/sign-up/email 再登录
 * 然后把 Karakeep 返回的会话 Cookie 原样交给浏览器，302 回到原页面。其余请求（含 WebSocket 升级）原样转发。
 *
 * 账号和 LobeHub 的本机主人相同（LOCAL_OWNER_EMAIL / LOCAL_OWNER_PASSWORD，只在本机配置里）。
 * 安全边界：只在监听地址是本机回环地址时开启；不打印任何密钥或 Cookie 值。
 */
const http = require('node:http');

const MARK = 'aroomo_al';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function hasCookie(header, name) {
  if (!header) return false;
  return String(header)
    .split(';')
    .some((p) => p.trim().startsWith(name + '='));
}

function wantsHtml(req) {
  return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

/** 登录后回到哪里：只接受本站相对路径；登录 / 注册页本身回首页 */
function safeTarget(raw) {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/^\/(signin|signup)(\/|\?|$)/.test(raw)) return '/';
  return raw;
}

/** 向内部 Karakeep 发一个请求，返回 { status, headers, body } 或 null（连不上 / 超时） */
function call(upstream, publicHost, method, path, { cookie, json, origin } = {}) {
  return new Promise((resolve) => {
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    const headers = { host: publicHost, accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const req = http.request({ host: '127.0.0.1', port: upstream, method, path, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

function createGate({ publicPort, upstreamPort, host, email, password, publicUrl }) {
  if (!LOOPBACK.has(host)) throw new Error('收藏的本机主人自动登录只能在只听本机（127.0.0.1）时开启');
  const origin = new URL(publicUrl).origin;
  const publicHost = new URL(publicUrl).host;
  let inflight;

  async function loggedIn(cookie) {
    if (!cookie) return false;
    const r = await call(upstreamPort, publicHost, 'GET', '/api/auth/get-session', { cookie });
    return !!(r && r.status === 200 && /"user"\s*:\s*\{/.test(r.body));
  }

  async function doLogin() {
    const cred = { email, password };
    const signIn = () => call(upstreamPort, publicHost, 'POST', '/api/auth/sign-in/email', { json: { ...cred, rememberMe: true }, origin });
    let r = await signIn();
    if (!r) return null;
    if (r.status < 200 || r.status >= 300) {
      if (![400, 401, 404].includes(r.status)) return null;
      // 第一次：主人账号还不存在 → 注册（第一个账号是收藏的管理员）
      const up = await call(upstreamPort, publicHost, 'POST', '/api/auth/sign-up/email', { json: { ...cred, name: 'Aroomo' }, origin });
      if (!up || up.status < 200 || up.status >= 300) {
        console.error(`karakeep-gate: 主人账号注册没有成功（HTTP ${up ? up.status : '连不上'}）`);
        return null;
      }
      const again = await signIn();
      const upCookies = [].concat(up.headers['set-cookie'] || []);
      r = again && again.status >= 200 && again.status < 300 && [].concat(again.headers['set-cookie'] || []).length > 0 ? again : upCookies.length ? up : null;
      if (!r) return null;
    }
    const cookies = [].concat(r.headers['set-cookie'] || []);
    return cookies.length > 0 ? cookies : null;
  }

  function login() {
    inflight ??= doLogin().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  function forward(req, res) {
    const up = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers },
      (ur) => {
        // 原始头原样交回（多个 Set-Cookie 等）
        res.writeHead(ur.statusCode || 502, ur.rawHeaders);
        ur.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('收藏正在启动，请稍后刷新。');
    });
    req.pipe(up);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (wantsHtml(req) && !hasCookie(req.headers.cookie, MARK) && !(await loggedIn(req.headers.cookie))) {
        const cookies = await login();
        if (cookies) {
          // 自动登录后 30 秒内不再尝试（Cookie 不生效时不无限跳转）
          res.writeHead(302, {
            location: safeTarget(req.url),
            'set-cookie': [...cookies, `${MARK}=1; Path=/; Max-Age=30; HttpOnly; SameSite=Lax`],
            'cache-control': 'no-store',
          });
          res.end();
          return;
        }
      }
    } catch (e) {
      console.error(`karakeep-gate: 自动登录出错：${e && e.message ? e.message : e}`);
    }
    forward(req, res);
  });

  // WebSocket 等升级请求：原样接到内部端口
  server.on('upgrade', (req, socket, head) => {
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers });
    up.on('upgrade', (ur, us, uh) => {
      let h = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`;
      for (let i = 0; i < ur.rawHeaders.length; i += 2) h += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
      socket.write(h + '\r\n');
      if (uh && uh.length) socket.write(uh);
      if (head && head.length) us.write(head);
      us.pipe(socket).pipe(us);
      us.on('error', () => socket.destroy());
      socket.on('error', () => us.destroy());
    });
    up.on('response', (ur) => {
      socket.end(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n\r\n`);
    });
    up.on('error', () => socket.destroy());
    up.end();
  });

  server.listen(publicPort, host);
  return server;
}

/** 找一个本机空闲端口（给内部的 Karakeep 用） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

module.exports = { createGate, freePort, safeTarget, hasCookie };
