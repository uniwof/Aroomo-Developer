// 界面冒烟（由 scripts/test-ui-e2e.sh 调用）。截图 + 页面结构导出到 E2E_REPORT_DIR，检查结果写 checks.json。
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.join(process.env.PW_DIR, 'noop.js'));
const { chromium, request } = require('playwright');

const base = process.env.E2E_BASE;
const out = process.env.E2E_REPORT_DIR;
mkdirSync(out, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
};

// 页面结构：左侧 420px 内与顶部 80px 内可见元素（用来核对隐藏规则和选择器）
const outline = () =>
  [...document.querySelectorAll('body *')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join('');
      return own || el.getAttribute('aria-label') || el.getAttribute('title') || ['A', 'BUTTON', 'svg', 'IMG', 'INPUT', 'TEXTAREA'].includes(el.tagName) || el.getAttribute('role');
    })
    .slice(0, 600)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join('').slice(0, 60);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        role: el.getAttribute('role') || undefined,
        label: el.getAttribute('aria-label') || el.getAttribute('title') || undefined,
        href: el.getAttribute('href') || undefined,
        testid: el.getAttribute('data-testid') || undefined,
        cls: (el.getAttribute('class') || '').slice(0, 80) || undefined,
        text: own || undefined,
        hidden: el.closest('[data-aroomo-hidden]') ? true : undefined,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    });

async function shoot(page, name) {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  writeFileSync(path.join(out, `${name}.outline.json`), JSON.stringify(await page.evaluate(outline), null, 1));
  writeFileSync(path.join(out, `${name}.text.txt`), await page.evaluate(() => document.body.innerText));
}

const api = await request.newContext({ baseURL: base });
const login = await api.post('/api/auth/sign-in/email', {
  data: { email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD },
  headers: { origin: base },
});
check('登录接口', login.ok(), login.status());
const storage = await api.storageState();

const browser = await chromium.launch();
for (const [label, viewport, isMobile] of [
  ['desktop', { width: 1280, height: 800 }, false],
  ['mobile', { width: 390, height: 844 }, true],
]) {
  const ctx = await browser.newContext({
    viewport,
    isMobile,
    hasTouch: isMobile,
    locale: 'en-US', // 故意用英文浏览器：应仍显示简体中文（Shell 默认 zh-CN）
    userAgent: isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : undefined,
    storageState: storage,
  });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await shoot(page, `${label}-first-open`);
  // 新用户引导：依次点「开始 / 下一步 / 跳过 / 完成」，最多 10 步，每步截图
  for (let i = 1; i <= 10; i++) {
    const path0 = new URL(page.url()).pathname;
    if (path0 === '/' && !(await page.getByRole('button', { name: /^(开始|下一步|跳过|继续|完成|Skip|Next|Start|Done)$/ }).count())) break;
    const btn = page.getByRole('button', { name: /^(跳过|开始|下一步|继续|完成|稍后|Skip|Next|Start|Done|Later)$/ }).first();
    if (!(await btn.count())) break;
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shoot(page, `${label}-onboarding-${i}`);
  }
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await shoot(page, `${label}-home`);
  const title = await page.title();
  check(`${label} 标题是 Aroomo`, /Aroomo/.test(title) && !/LobeHub/.test(title), title);
  const text = await page.evaluate(() => document.body.innerText);
  check(`${label} 页面上看不到 LobeHub / Lobe AI`, !/LobeHub|LobeChat|Lobe AI/.test(text), (text.match(/.{0,30}(LobeHub|LobeChat|Lobe AI).{0,30}/) || [''])[0]);
  check(`${label} 简体中文`, /[\u4e00-\u9fa5]/.test(text), text.slice(0, 80));
  check(`${label} 上游文字 Logo 已替换`, (await page.locator('svg[data-aroomo-logo]:visible').count()) === 0);
  const dockVisible = await page.locator('#aroomo-dock').isVisible().catch(() => false);
  check(`${label} 底部图标（收藏 / 成员 / 收件箱 / 设置）`, dockVisible && (await page.locator('#aroomo-dock a').count()) === 4, new URL(page.url()).pathname);
  check(`${label} shell.js 已加载`, await page.evaluate(() => Boolean(window.__aroomoShell)));
  const hiddenVisible = await page.evaluate(() => {
    const bad = ['发现', '社区', '市场', '图片', '视频', '文稿', '资源', '记忆', '朗读', '语音服务'];
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.offsetParent !== null && !el.closest('[data-aroomo-hidden]'))
      .map((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join(''))
      .filter((t) => bad.includes(t));
  });
  check(`${label} §8 之外的入口已隐藏`, hiddenVisible.length === 0, hiddenVisible.join(','));
  // 打开一个对话（会话列表里的第一项 / 资源管家）
  const firstChat = page.locator('a[href^="/agent/"]').first();
  if (await firstChat.count()) {
    await firstChat.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  await shoot(page, `${label}-chat`);

  await page.goto(base + '/community', { waitUntil: 'domcontentloaded' });
  check(`${label} /community 跳回首页`, new URL(page.url()).pathname === '/', page.url());
  await page.goto(base + '/settings/tts', { waitUntil: 'domcontentloaded' });
  check(`${label} /settings 跳到 Aroomo 设置`, new URL(page.url()).pathname.startsWith('/aroomo/settings'), page.url());
  await shoot(page, `${label}-settings`);
  const tabs = await page.locator('.vtabs a').allInnerTexts();
  check(`${label} 设置 6 个 Tab`, tabs.join('/') === '通用/负责人/账号/通知/安全/高级', tabs.join('/'));
  for (const p of ['members', 'inbox', 'favorites']) {
    await page.goto(`${base}/aroomo/${p}`, { waitUntil: 'domcontentloaded' });
    await shoot(page, `${label}-aroomo-${p}`);
  }
  const tts = await page.evaluate(() => fetch('/webapi/tts/openai', { method: 'POST' }).then((r) => r.status).catch((e) => String(e)));
  check(`${label} 朗读接口禁用`, tts === 403 || /朗读功能已关闭/.test(String(tts)), tts);
  check(`${label} 首页没有脚本错误`, jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  await ctx.close();
}
await browser.close();
writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
const failed = checks.filter((c) => !c.ok);
// 第一轮只把核心项设为必须通过；其余写进报告供核对选择器
const required = /标题是 Aroomo|shell.js 已加载|跳回首页|跳到 Aroomo 设置|设置 6 个 Tab|朗读接口禁用|登录接口/;
const hard = failed.filter((c) => required.test(c.name));
console.log(`\n${checks.length - failed.length}/${checks.length} 通过；必须项失败 ${hard.length}`);
process.exit(hard.length ? 1 : 0);
