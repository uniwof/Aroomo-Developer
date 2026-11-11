// #377 M3（负责人第 1 轮）：设了 CORE_OWNER_ACCOUNT_ID 的「并入」端到端（由 scripts/test-ui-e2e.sh 在 Core 带上它重启后调用）。
// 所有者：先在本机种 'owner' 那份（以前从 Shell 打开时存的），从 Shell 打开 /console/chat →
//   直通 /api/auth/me 回她自己的账号 + ownerAccount=true → 'owner' 那份并进她账号那份；'owner' 那份原样保留；刷新后不重复。
// 家人对照：Shell 只给所有者开 /console（家人 403，控制台不运行，不会并入）；直通回家人自己、ownerAccount=false；同机 'owner' 那份不动。
// 说明：这版控制台 SAVED_CHATS=false（会话存在本机浏览器），所以这里断言的是「她账号那份 + 页面列表」，不查服务端会话表。
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.join(process.env.PW_DIR, 'noop.js'));
const { chromium } = require('playwright');

const base = process.env.E2E_BASE;
const out = process.env.E2E_REPORT_DIR;
const ownerId = process.env.E2E_OWNER_ID;
mkdirSync(out, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
};

const OWNER_KEY = 'aroomo.chat.v1:u:owner';
const now = Date.now();
const conv = (id, title, t) => ({ id, title, model: 'aroomo', updatedAt: t, messages: [{ id: `${id}-u`, role: 'user', text: `${title}（以前从 Shell 打开时说的）`, at: t }] });
const OWNER_SHARE = JSON.stringify([conv('e2e-merge-1', '并入测试甲', now - 1000), conv('e2e-merge-2', '并入测试乙', now - 2000)]);
const SEEDED = ['e2e-merge-1', 'e2e-merge-2'];

const onConsole = (u) => new URL(u).pathname.startsWith('/console');
const whoAmI = (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, kind: b.kind, id: b.user?.id ?? null, ownerAccount: b.ownerAccount, upstream: r.headers.get('x-aroomo-upstream') };
  });
const read = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const ids = (raw) => {
  try {
    return (JSON.parse(raw ?? '[]') ?? []).map((c) => c.id);
  } catch {
    return [];
  }
};

const browser = await chromium.launch();

// —— 所有者 ——
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(base + '/console/', { waitUntil: 'domcontentloaded' });
  await page.fill('#email', process.env.E2E_EMAIL);
  await page.fill('#password', process.env.E2E_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(onConsole, { timeout: 30000 }).catch(() => {});
  check('并入 所有者从 Shell 登录进入 /console', onConsole(page.url()), page.url());
  const who = await whoAmI(page);
  check('并入 所有者直通 /api/auth/me：她自己的账号 + ownerAccount=true', who.status === 200 && who.kind === 'user' && who.id === ownerId && who.ownerAccount === true && who.upstream === 'core', JSON.stringify(who));
  const mine = `aroomo.chat.v1:u:${who.id}`;
  // 种 'owner' 那份；她账号那份先清空（干净起点）
  await page.evaluate(([k, v, m]) => { localStorage.setItem(k, v); localStorage.removeItem(m); }, [OWNER_KEY, OWNER_SHARE, mine]);
  await page.goto(base + '/console/chat', { waitUntil: 'networkidle' });
  await page.waitForFunction(([m, want]) => want.every((id) => (localStorage.getItem(m) ?? '').includes(id)), [mine, SEEDED], { timeout: 15000 }).catch(() => {});
  const got = ids(await read(page, mine));
  check('并入 \'owner\' 那份并进她账号那份（两段都在）', SEEDED.every((id) => got.includes(id)), JSON.stringify(got));
  const listed = await page.getByText('并入测试甲').first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('并入 页面会话列表里看得到并进来的会话', listed);
  check('并入 \'owner\' 那份原样保留（不删不改）', (await read(page, OWNER_KEY)) === OWNER_SHARE);
  await page.screenshot({ path: path.join(out, 'merge-owner.png') });
  // 刷新：不重复
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(6000); // 问 Core 最多等 5 秒（ACCOUNT_TIMEOUT_MS）
  const again = ids(await read(page, mine));
  const dup = SEEDED.map((id) => again.filter((x) => x === id).length);
  check('并入 刷新后不重复（每段只有一份）', dup.every((n) => n === 1), JSON.stringify(again));
  check('并入 刷新后 \'owner\' 那份仍原样', (await read(page, OWNER_KEY)) === OWNER_SHARE);
  await ctx.close();
}

// —— 家人对照：不并入 ——
// Shell 的 /console 只给所有者（ownerOk：admin + SHELL_OWNER_EMAIL），家人从 Shell 打开拿到 403，控制台不运行，也就不会并入。
// 这里如实断言这道门 + 直通回的是家人自己（ownerAccount=false）+ 同机的 'owner' 那份不动、家人那份里没有它们。
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(`${base}/aroomo/accept?token=${encodeURIComponent(process.env.E2E_FAMILY_INVITE ?? '')}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', process.env.E2E_FAMILY_PASSWORD);
  await page.fill('#password2', process.env.E2E_FAMILY_PASSWORD);
  await page.click('button[type="submit"]');
  const said = await page.waitForFunction(() => /没有权限使用所有者的控制台/.test(document.getElementById('msg')?.textContent ?? ''), null, { timeout: 30000 }).then(() => true, () => false);
  check('并入 家人设密码后已登录，但 Shell 不给家人开所有者控制台（留在设密码页提示）', said && !onConsole(page.url()), `${page.url()} ${(await page.locator('#msg').textContent().catch(() => '')) ?? ''}`);
  const who = await whoAmI(page);
  check('并入 家人直通 /api/auth/me：家人自己的账号，ownerAccount=false', who.status === 200 && who.kind === 'user' && Boolean(who.id) && who.id !== ownerId && who.ownerAccount === false, JSON.stringify(who));
  const theirs = `aroomo.chat.v1:u:${who.id}`;
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [OWNER_KEY, OWNER_SHARE]);
  const res = await page.goto(base + '/console/chat', { waitUntil: 'domcontentloaded' });
  const isConsole = await page.evaluate(() => Boolean(document.querySelector('meta[name="aroomo-shell"]')));
  check('并入 家人对照：从 Shell 打开 /console 是 403，控制台不运行', res?.status() === 403 && !isConsole, `HTTP ${res?.status()} 控制台 ${isConsole}`);
  await page.waitForTimeout(3000);
  const got = ids(await read(page, theirs));
  check('并入 家人对照：家人那份里没有所有者的会话', SEEDED.every((id) => !got.includes(id)), JSON.stringify(got));
  check('并入 家人对照：\'owner\' 那份原样', (await read(page, OWNER_KEY)) === OWNER_SHARE);
  await page.screenshot({ path: path.join(out, 'merge-family.png') });
  await ctx.close();
}

await browser.close();
writeFileSync(path.join(out, 'merge-checks.json'), JSON.stringify(checks, null, 1));
const failed = checks.filter((c) => !c.ok);
console.log(`\n并入 e2e：${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
