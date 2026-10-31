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
// 登录页（未登录）
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(base + '/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await shoot(page, 'desktop-signin');
  const t = await page.evaluate(() => document.body.innerText);
  // D190：LobeHub 保留自己的品牌（所有者已接受），这里只确认登录页能打开
  check('登录页可打开', t.trim().length > 0, t.slice(0, 80));
  await ctx.close();
}
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
  // 新用户引导（LobeHub 自带）：依次点「开始 / 下一步 / 跳过 / 完成」或右侧的「→」图标按钮，最多 12 步，每步截图
  for (let i = 1; i <= 12; i++) {
    if (!new URL(page.url()).pathname.startsWith('/onboarding')) break;
    const named = page.getByRole('button', { name: /^(跳过|开始|下一步|继续|完成|稍后|确定|Skip|Next|Start|Done|Later)$/ }).first();
    if (await named.count()) {
      await named.click({ timeout: 5000 }).catch(() => {});
    } else {
      // 没有文字的「下一步」图标按钮：页面中部、不在顶栏、不是「上一步」，取面积最大的那个
      const idx = await page.evaluate(() => {
        const bs = [...document.querySelectorAll('button')];
        const ok = (b) => {
          const r = b.getBoundingClientRect();
          return r.top >= 100 && r.width && !/上一步|Back/.test(b.innerText) && !b.closest('#aroomo-dock')
            && b.getAttribute('role') !== 'combobox' && !b.hasAttribute('aria-haspopup') && !b.hasAttribute('aria-expanded');
        };
        // 先找带「→」图标的按钮（语言选择那一步：下拉框旁边的圆形箭头）
        const arrow = bs.findIndex((b) => ok(b) && b.querySelector('svg.lucide-arrow-right,svg.lucide-chevron-right,svg.lucide-send,svg.lucide-check'));
        if (arrow >= 0) return arrow;
        let best = -1, area = 0;
        bs.forEach((b, i) => {
          if (!ok(b)) return;
          const r = b.getBoundingClientRect();
          if (r.width * r.height > area) { area = r.width * r.height; best = i; }
        });
        return best;
      });
      if (idx < 0) break;
      await page.locator('button').nth(idx).click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
    await shoot(page, `${label}-onboarding-${i}`);
  }
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await shoot(page, `${label}-home`);
  // D190：LobeHub 原样使用——页面不再注入 Aroomo 的 CSS / JS，不替换品牌，不隐藏入口
  const text = await page.evaluate(() => document.body.innerText);
  check(`${label} 简体中文`, /[\u4e00-\u9fa5]/.test(text), text.slice(0, 80));
  const injected = await page.evaluate(() => ({
    shell: Boolean(window.__aroomoShell),
    tags: [...document.querySelectorAll('script[src],link[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')).filter((u) => u && u.includes('/aroomo/static/')),
  }));
  check(`${label} D190 页面未被注入`, !injected.shell && injected.tags.length === 0, JSON.stringify(injected));
  // 打开一个对话（会话列表里的第一项 / 资源管家）
  const firstChat = page.locator('a[href^="/agent/"]').first();
  if (await firstChat.count()) {
    await firstChat.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  await shoot(page, `${label}-chat`);

  // 旧 /aroomo 页面已被控制台取代：必须跳转到 /console/（旧页面逐页点测随旧页面删除，控制台页面由 web/console 自己的测试负责）
  await page.goto(base + '/aroomo/members', { waitUntil: 'domcontentloaded' });
  check(`${label} 旧 /aroomo 跳转到 /console`, new URL(page.url()).pathname.startsWith('/console'), page.url());

  if (!isMobile) {
    // —— 对话：填一个指向假模型的 Key，在 LobeHub 里说一句话（LobeHub → Core → LiteLLM → 模型，PRODUCT 16.1）——
    const k = await page.evaluate((fake) =>
      fetch('/aroomo/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aroomo-request': '1' },
        // 底层模型名用 LiteLLM 认识的 gpt-4o-mini（能对话、128k、工具调用 → 可当负责人），请求实际发往假模型服务
        body: JSON.stringify({ name: '假模型', sourceUrl: 'https://example.com/keys', model: 'openai/gpt-4o-mini', modelName: 'Fake Model', apiBase: 'http://fake-llm:8000/v1', apiKey: fake }),
      })
        .then((r) => r.status)
        // §9.1：新模型先进候选，一键入职
        .then((st) => fetch('/aroomo/api/members/fake-model/onboard', { method: 'POST', headers: { 'x-aroomo-request': '1' } }).then((r) => (st === 201 && r.ok ? 201 : `${st}/${r.status}`))),
      ['placeholder', 'sk', 'fake', 'ABCDEFGHIJKLMNOP'].join('-'),
    );
    check('对话：填入指向假模型的 Key', k === 201, k);
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    const input = page.locator('[data-testid="chat-input"] [contenteditable="true"], [data-testid="chat-input"] textarea').first();
    await input.waitFor({ timeout: 30000 }).catch(() => {});
    const sendAndWait = async (msg, expect) => {
      await input.click().catch(() => {});
      await page.keyboard.type(msg);
      await page.keyboard.press('Enter');
      return page.getByText(expect).first().waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
    };
    // 假模型回「你好，我是测试模型（<LiteLLM 里的底层模型名>）」，底层名是 fake-model
    const ok1 = await sendAndWait('你好', /你好，我是测试模型（/);
    await shoot(page, 'desktop-chat-reply');
    check('对话：填 Key 后能和模型对话（交给负责人）', ok1, (await page.evaluate(() => document.body.innerText)).slice(-400));
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('对话：回答署名「（负责人）」', bodyText.includes('Fake Model（负责人）'), bodyText.slice(-300));
    const ok2 = await sendAndWait('@Nobody 在吗', '没有叫「Nobody」的成员');
    await shoot(page, 'desktop-chat-mention');
    check('对话：点名不存在的成员只给提示（D31）', ok2);
    // D190：@ 联想脚本（mention.js）已删除；成员 @ 改由 LobeHub 群组原生功能承担（D189，V3 验证）
  }

  check(`${label} 首页没有脚本错误`, jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  await ctx.close();
}
await browser.close();
writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
const failed = checks.filter((c) => !c.ok);
// 第一轮只把核心项设为必须通过；其余写进报告供核对选择器
const required = /D190 页面未被注入|设置 6 个 Tab|登录接口|填 Key|Key 明文|对话：|进入候选|一键入职|退出登录|敏感内容保护开关|发收件箱卡片|确认卡|倒计时|处理完毕|删除 Key/;
const hard = failed.filter((c) => required.test(c.name));
console.log(`\n${checks.length - failed.length}/${checks.length} 通过；必须项失败 ${hard.length}`);
process.exit(hard.length ? 1 : 0);
