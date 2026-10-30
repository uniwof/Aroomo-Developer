'use strict';
/**
 * 独立版安装时运行（用随包附带的 node.exe）：核对并解开 LobeHub 官方镜像里的程序（lobe.tar.gz），DECISIONS D66。
 *
 * 为什么不用 Inno Setup 直接装这些文件：
 *   1. LobeHub 用 pnpm，node_modules 里有 877 个符号链接；Windows 上普通用户建不了符号链接，
 *      但能建「目录联接」（junction，pnpm 在 Windows 上也是这么做的）。
 *   2. 一些路径超过 260 个字符；Node 的文件接口自己处理长路径，不依赖系统的「长路径」开关。
 *
 * 用法：
 *   node unpack-lobe.cjs <lobe.tar.gz> <目标文件夹> <SHA-256>   解开（先核对 SHA-256；目标文件夹必须不存在或为空）
 *   node unpack-lobe.cjs --remove <文件夹>                       删除（不跟随联接，卸载时用）
 * 压缩包格式：gzip 压缩的 pax / ustar tar，顶层目录 app/（去掉后放进目标文件夹）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function fail(msg) {
  console.error(`unpack-lobe: ${msg}`);
  process.exit(1);
}

if (process.argv[2] === '--remove') {
  const dir = process.argv[3];
  if (!dir || path.parse(path.resolve(dir)).root === path.resolve(dir)) fail('要删除的文件夹不对');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  console.log(`unpack-lobe: 已删除 ${dir}`);
  process.exit(0);
}

const [archive, destArg, expected] = process.argv.slice(2);
if (!archive || !destArg || !/^[0-9a-f]{64}$/.test(expected || '')) fail('用法：node unpack-lobe.cjs <lobe.tar.gz> <目标文件夹> <SHA-256>');
const dest = path.resolve(destArg);

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p, { highWaterMark: 4 << 20 })
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** 把 tar 里的路径变成目标文件夹里的安全路径；去掉顶层 app/；拒绝绝对路径和 .. */
function safeTarget(name) {
  const clean = name.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = clean.split('/').filter((p) => p !== '' && p !== '.');
  if (parts[0] !== 'app') return null;
  parts.shift();
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || /[<>:"|?*\x00-\x1f]/.test(p))) fail(`压缩包里有不安全的路径：${name}`);
  return path.join(dest, ...parts);
}

function octal(buf, start, len) {
  const b = buf.subarray(start, start + len);
  if (b[0] & 0x80) {
    // base-256（超大文件）
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
    return n;
  }
  const s = b.toString('ascii').replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function cstr(buf, start, len) {
  return buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString('ascii'), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

async function main() {
  if (!fs.existsSync(archive)) fail(`找不到 ${archive}`);
  console.log('unpack-lobe: 正在核对文件完整性（SHA-256）。');
  const actual = await sha256File(archive);
  if (actual !== expected) fail(`文件不完整或被改动过（SHA-256 ${actual}，应为 ${expected}）`);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) fail(`目标文件夹不是空的：${dest}`);
  fs.mkdirSync(dest, { recursive: true });

  const total = fs.statSync(archive).size;
  let read = 0;
  let lastPct = -1;
  const made = new Set();
  const mkdirp = (d) => {
    if (made.has(d)) return;
    fs.mkdirSync(d, { recursive: true });
    made.add(d);
  };

  let pending = Buffer.alloc(0);
  let st = { kind: 'header' };
  let pax = {};
  let gnuName = null;
  let gnuLink = null;
  const links = [];
  let files = 0;

  const startData = (kind, size, extra) => {
    const pad = (512 - (size % 512)) % 512;
    st = { kind, remaining: size, pad, chunks: [], ...extra };
    if (size === 0) finishData();
  };

  function finishData() {
    const s = st;
    if (s.kind === 'file') {
      fs.closeSync(s.fd);
      files++;
    } else if (s.kind === 'pax') {
      pax = { ...pax, ...parsePax(Buffer.concat(s.chunks)) };
    } else if (s.kind === 'gnuname') {
      gnuName = Buffer.concat(s.chunks).toString('utf8').replace(/\0.*$/s, '');
    } else if (s.kind === 'gnulink') {
      gnuLink = Buffer.concat(s.chunks).toString('utf8').replace(/\0.*$/s, '');
    }
    st = { kind: 'pad', remaining: s.pad };
    if (s.pad === 0) st = { kind: 'header' };
  }

  function onHeader(h) {
    if (h.every((b) => b === 0)) return; // 结尾的空块
    const type = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12);
    if (type === 'x') return startData('pax', size);
    if (type === 'g') return startData('skip', size);
    if (type === 'L') return startData('gnuname', size);
    if (type === 'K') return startData('gnulink', size);
    const prefix = h.subarray(257, 262).toString('ascii') === 'ustar' ? cstr(h, 345, 155) : '';
    const base = cstr(h, 0, 100);
    const name = pax.path || gnuName || (prefix ? `${prefix}/${base}` : base);
    const linkName = pax.linkpath || gnuLink || cstr(h, 157, 100);
    pax = {};
    gnuName = null;
    gnuLink = null;
    const target = safeTarget(name);
    if (type === '0' || type === '\0' || type === '7') {
      if (!target) return startData('skip', size);
      mkdirp(path.dirname(target));
      return startData('file', size, { fd: fs.openSync(target, 'w') });
    }
    if (type === '5') {
      if (target) mkdirp(target);
      return startData('skip', size);
    }
    if ((type === '2' || type === '1') && target) {
      links.push({ link: target, to: type === '2' ? path.resolve(path.dirname(target), linkName) : safeTarget(linkName), hard: type === '1' });
    }
    return startData('skip', size);
  }

  function consume() {
    for (;;) {
      if (st.kind === 'header') {
        if (pending.length < 512) return;
        const h = pending.subarray(0, 512);
        pending = pending.subarray(512);
        onHeader(h);
        continue;
      }
      if (pending.length === 0) return;
      const n = Math.min(st.remaining, pending.length);
      const piece = pending.subarray(0, n);
      pending = pending.subarray(n);
      st.remaining -= n;
      if (st.kind === 'file') fs.writeSync(st.fd, piece);
      else if (st.kind === 'pax' || st.kind === 'gnuname' || st.kind === 'gnulink') st.chunks.push(Buffer.from(piece));
      if (st.remaining === 0) {
        if (st.kind === 'pad') st = { kind: 'header' };
        else finishData();
      }
    }
  }

  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(archive, { highWaterMark: 4 << 20 });
    src.on('data', (c) => {
      read += c.length;
      const pct = Math.floor((read / total) * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        console.log(`unpack-lobe: 已解开 ${pct}%`);
      }
    });
    const gun = zlib.createGunzip({ chunkSize: 1 << 20 });
    gun.on('data', (c) => {
      pending = pending.length ? Buffer.concat([pending, c]) : c;
      try {
        consume();
      } catch (err) {
        reject(err);
      }
    });
    gun.on('end', resolve);
    gun.on('error', reject);
    src.on('error', reject);
    src.pipe(gun);
  });
  if (st.kind !== 'header' && !(st.kind === 'pad')) fail('压缩包不完整');

  // 链接：目录 → 联接（junction）；文件 → 复制。目标本身可能也是链接，所以多轮处理直到没有进展。
  let todo = links;
  let skipped = 0;
  for (let round = 0; todo.length > 0 && round < 10; round++) {
    const next = [];
    for (const l of todo) {
      let s;
      try {
        s = fs.statSync(l.to);
      } catch {
        next.push(l);
        continue;
      }
      mkdirp(path.dirname(l.link));
      if (s.isDirectory()) fs.symlinkSync(l.to, l.link, 'junction');
      else fs.copyFileSync(l.to, l.link);
    }
    if (next.length === todo.length) {
      skipped = next.length; // 指向不存在的目标（上游镜像里本来就是断链）
      break;
    }
    todo = next;
  }
  console.log(`unpack-lobe: 完成。文件 ${files} 个，链接 ${links.length - skipped} 个${skipped ? `（跳过断链 ${skipped} 个）` : ''}。`);
}

main().catch((err) => fail(`解开失败（${(err && err.code) || (err && err.name) || 'Error'}）`));
