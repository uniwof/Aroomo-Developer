// #350：「Aroomo 正在准备」页（独立版启动页，两份副本）不能把 ?to= 里的原字符串交给 fetch / location。
// 用 node:vm 跑页面里的脚本，假的 location / fetch 记录它实际去了哪里。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const COPIES: [string, string] = ['../../assets/brand/preparing.html', '../../installer/standalone/runtime/preparing.html'].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
) as [string, string];

function pageScript(file: string): string {
  const html = readFileSync(file, 'utf8');
  // 页面只有一个内联 <script>，按固定标记截取（只读自家文件，不做 HTML 过滤）
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) throw new Error(`no <script> in ${file}`);
  return html.slice(start + '<script>'.length, end);
}

async function run(file: string, search: string): Promise<{ fetched: string[]; replaced: string[] }> {
  const fetched: string[] = [];
  const replaced: string[] = [];
  const ctx = {
    URLSearchParams,
    Date,
    location: { search, replace: (u: string) => replaced.push(String(u)) },
    fetch: (u: string) => {
      fetched.push(String(u));
      return Promise.resolve({});
    },
    setTimeout: () => 0,
    document: { getElementById: () => ({ textContent: '' }) },
  };
  vm.runInNewContext(pageScript(file), ctx);
  await new Promise((r) => setImmediate(r));
  return { fetched, replaced };
}

const q = (to: string) => '?to=' + encodeURIComponent(to);

describe.each(COPIES)('preparing.html 跳转地址（%s）', (file) => {
  it.each([
    ['', 'http://localhost:3280'],
    [q('http://localhost:3280'), 'http://localhost:3280'],
    [q('http://localhost:3280/'), 'http://localhost:3280'],
    [q('http://127.0.0.1:4100'), 'http://127.0.0.1:4100'],
  ])('合法的本机地址照常跳转 %s', async (search, want) => {
    const r = await run(file, search);
    expect(r.fetched).toEqual([want + '/']);
    expect(r.replaced).toEqual([want]);
  });

  it.each([
    'javascript:alert(document.cookie)',
    'javascript://localhost:3280/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://evil.example:3280',
    'http://localhost:3280.evil.example',
    'http://localhost:3280/#"><img src=x onerror=alert(1)>',
    'http://localhost:3280\njavascript:alert(1)',
    'http://localhost:99999',
    'http://localhost:0',
  ])('恶意或越界的 ?to= 一律退回默认地址：%s', async (bad) => {
    const r = await run(file, q(bad));
    expect(r.fetched).toEqual(['http://localhost:3280/']);
    expect(r.replaced).toEqual(['http://localhost:3280']);
  });

  it('跳转用的是重新拼出的字符串，不是 ?to= 原值', async () => {
    const r = await run(file, q('http://localhost:03280/'));
    expect(r.replaced).toEqual(['http://localhost:3280']);
  });
});

it('两份 preparing.html 的脚本保持一致', () => {
  expect(pageScript(COPIES[0])).toBe(pageScript(COPIES[1]));
});
