'use strict';
// CodeQL #6（#373）：karakeep-gate 自动登录后 302 的跳转目标只收同源相对路径。规则与判据同 shell 的 safeLocalPath（#357）。
// 运行：node --test installer/standalone/test/karakeep-gate.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGate, safeTarget } = require('../runtime/karakeep-gate.cjs');

const ALPHA = ['/', '\\', '.', '\t', '\n', '\r', 'a', ':', '@', '%', ' ', '中'];
const EXTRA = ['\x00', '\x1f', '\x7f', '\u3000', '\uFF0F', '?', '#'];
function* strings(max, alpha = ALPHA) {
  let layer = [''];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alpha.map((c) => s + c));
    yield* layer;
  }
}
const BASE = 'http://host.test';
const hostOf = (s) => {
  try {
    return new URL(s, BASE).host;
  } catch {
    return null;
  }
};
// #386 第 1 轮 M1：点段 / 反斜杠归一化后路径以 // 开头，下一跳就成了协议相对地址（安全押在 Karakeep 第二跳上），一律不放行
const dblSlash = (s) => {
  try {
    return new URL(s, BASE).pathname.startsWith('//');
  } catch {
    return false;
  }
};

function check(fn, max, alpha) {
  const offSite = [];
  const nonAscii = [];
  const slashSlash = [];
  const ctrlKept = [];
  let rawEscapes = 0;
  for (const s of strings(max, alpha)) {
    const h = hostOf(s);
    if (h !== null && h !== 'host.test') rawEscapes++;
    const out = fn(s);
    if (out !== '/' && hostOf(out) !== 'host.test') offSite.push(JSON.stringify(s));
    if (!/^[\x21-\x7e]+$/.test(out)) nonAscii.push(JSON.stringify(s));
    if (out !== '/' && dblSlash(out)) slashSlash.push(JSON.stringify(s));
    // 规则本身：含控制字符（浏览器会剥掉，结果不可预期）的一律回 /，不靠后面的百分号编码兜住
    if (/[\x00-\x1f\x7f]/.test(s) && out !== '/') ctrlKept.push(JSON.stringify(s));
  }
  return { offSite: offSite.slice(0, 5), nonAscii: nonAscii.slice(0, 5), slashSlash: slashSlash.slice(0, 5), ctrlKept: ctrlKept.slice(0, 5), rawEscapes };
}

test('穷举（长度 ≤5）：结果为 / 或解析后仍在本站，且只含 U+0021–U+007E；判据在原始输入上能找到外跳', () => {
  const r = check(safeTarget, 5);
  assert.deepEqual(r.offSite, []);
  assert.deepEqual(r.nonAscii, []);
  assert.deepEqual(r.slashSlash, []);
  assert.deepEqual(r.ctrlKept, []);
  assert.ok(r.rawEscapes > 0, '判据不是恒真');
});

test('穷举（补充 NUL/US/DEL/全角空格/全角斜杠/?/#，长度 ≤4）同一判据', () => {
  const r = check(safeTarget, 4, [...ALPHA, ...EXTRA]);
  assert.deepEqual(r.offSite, []);
  assert.deepEqual(r.nonAscii, []);
  assert.deepEqual(r.slashSlash, []);
  assert.deepEqual(r.ctrlKept, []);
  assert.ok(r.rawEscapes > 0);
});

test('回退自检：修复前的规则（不查控制字符、不编码）在同一判据下会失败', () => {
  const old = (raw) => {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
    if (/^\/(signin|signup)(\/|\?|$)/.test(raw)) return '/';
    return raw;
  };
  const r = check(old, 4, [...ALPHA, ...EXTRA]);
  assert.ok(r.offSite.length > 0, '旧规则应能被 /<TAB>/x 之类外跳');
  assert.ok(r.nonAscii.length > 0);
});

test('显式用例', () => {
  for (const c of ['\x00', '\x1f', '\x7f', '\r', '\t\\']) {
    assert.equal(safeTarget(`/${c}/evil.example`), '/');
  }
  assert.equal(safeTarget('/signin?x'), '/');
  assert.equal(safeTarget('/signup'), '/');
  assert.equal(safeTarget('/bookmarks?q=1'), '/bookmarks?q=1');
  assert.equal(safeTarget('/中'), '/%E4%B8%AD');
  // #386 M1：点段归一化后以 // 开头的一律回 /
  for (const s of ['/.//x', '/a/..//x', '/./\\x', '/.//evil.example/x']) assert.equal(safeTarget(s), '/', JSON.stringify(s));
  for (const s of ['/%2F%2Fevil.example', '/\u3000/evil.example', '/\uFF0F/evil.example']) {
    const out = safeTarget(s);
    assert.equal(hostOf(out), 'host.test', `${JSON.stringify(s)} → ${out}`);
    assert.match(out, /^[\x21-\x7e]+$/);
  }
});

// 集成：假的 Karakeep（Better Auth），原始请求行进 gate，确认走了自动登录分支且跳转仍在本站
// #386 M2：输出和输入不同的用例（gate 绕过 safeTarget 就会红）；同源原样的一条做正向对照
test('集成：原始请求行 //evil.example/x、/\\evil.example、/.//evil.example/x、/signin?x=1 → 302 Location: /；/%E4%B8%AD?a=1 原样；带自动登录标记', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/auth/sign-in/email') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'tok=1; Path=/; HttpOnly' });
        return res.end('{}');
      }
      if (req.url === '/api/auth/get-session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('null');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const gate = createGate({
    publicPort: 0,
    upstreamPort: upstream.address().port,
    host: '127.0.0.1',
    email: 'o@aroomo.local',
    password: 'x'.repeat(20),
    publicUrl: 'http://127.0.0.1:1',
  });
  await new Promise((r) => (gate.listening ? r() : gate.once('listening', r)));
  const port = gate.address().port;
  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers: { accept: 'text/html' } }, (res) => {
        res.resume();
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    });
  try {
    for (const [path, want] of [
      ['//evil.example/x', '/'],
      ['/\\evil.example', '/'],
      ['/.//evil.example/x', '/'],
      ['/signin?x=1', '/'],
      ['/%E4%B8%AD?a=1', '/%E4%B8%AD?a=1'],
    ]) {
      const r = await get(path);
      assert.equal(r.statusCode, 302);
      assert.match([].concat(r.headers['set-cookie'] || []).join('\n'), /aroomo_al=1/);
      assert.equal(r.headers.location, want);
      assert.equal(new URL(r.headers.location, `http://127.0.0.1:${port}`).host, `127.0.0.1:${port}`);
    }
    const after = await get('/x');
    assert.equal(after.statusCode, 302);
  } finally {
    gate.close();
    upstream.close();
  }
});
