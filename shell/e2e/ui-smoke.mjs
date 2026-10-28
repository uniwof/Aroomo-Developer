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
// 登录页（未登录）：确认 Logo / 主题色
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(base + '/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await shoot(page, 'desktop-signin');
  const t = await page.evaluate(() => document.body.innerText);
  check('登录页看不到 LobeHub', !/LobeHub|LobeChat/.test(t), (t.match(/.{0,30}(LobeHub|LobeChat).{0,30}/) || [''])[0]);
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
  const title = await page.title();
  check(`${label} 标题是 Aroomo`, /Aroomo/.test(title) && !/LobeHub/.test(title), title);
  const text = await page.evaluate(() => document.body.innerText);
  check(`${label} 页面上看不到 LobeHub / Lobe AI`, !/LobeHub|LobeChat|Lobe\s?AI/.test(text), (text.match(/.{0,30}(LobeHub|LobeChat|Lobe\s?AI).{0,30}/) || [''])[0]);
  check(`${label} 简体中文`, /[\u4e00-\u9fa5]/.test(text), text.slice(0, 80));
  check(`${label} 上游文字 Logo 已替换`, (await page.locator('svg[data-aroomo-logo]:visible').count()) === 0);
  const dockVisible = await page.locator('#aroomo-dock').isVisible().catch(() => false);
  check(`${label} 底部图标（收藏 / 成员 / 收件箱 / 设置）`, dockVisible && (await page.locator('#aroomo-dock a[data-aroomo-dock]').count()) === 4, new URL(page.url()).pathname);
  check(`${label} 首页没有上游吉祥物（运营素材图）`, (await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => /lobeobjects\.space\/dc\/ops-assets\//.test(i.currentSrc || i.src) && i.getBoundingClientRect().width).length)) === 0);
  const promo = await page.evaluate(() => (document.body.innerText.match(/^(上新|推荐)$/gm) || []).join('/'));
  check(`${label} 首页没有「上新」「推荐」推广条`, promo === '', promo);
  check(`${label} 侧栏有 Aroomo 标志`, (await page.locator('#aroomo-dock .aroomo-dock-brand svg').count()) === 1);
  // —— 品牌与主题色（主人的 Logo + 珊瑚色 #ff7f50）：诊断写进 theme.json，供核对 ——
  const theme = await page.evaluate(async () => {
    const vars = window.__aroomoThemeVars || {};
    const coral = /rgb\((255, 127, 80|255, 147, 107|232, 105, 60|255, 154, 115|229, 103, 59)\)/;
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => { const cs = getComputedStyle(b); return { text: (b.innerText || b.getAttribute('aria-label') || '').slice(0, 20), bg: cs.backgroundColor, color: cs.color, cls: (b.className || '').toString().slice(0, 60) }; });
    const icons = [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"],link[rel="manifest"],meta[name="theme-color"]')].map((l) => l.outerHTML);
    const manifest = await fetch('/manifest.json').then((r) => r.json()).catch(() => null);
    const size = (u) => fetch(u, { cache: 'no-store' }).then((r) => r.blob()).then((b) => b.size).catch(() => -1);
    return {
      vars, icons, themeColor: manifest && manifest.theme_color,
      coralButtons: buttons.filter((b) => coral.test(b.bg)),
      buttons: buttons.slice(0, 40),
      lobeAvatar: await size('/avatars/lobe-ai.png'), aroomoAvatar: await size('/aroomo/static/avatar.png'),
      appIcon: await size('/app-icons/icon-192x192.png'), aroomoIcon: await size('/aroomo/static/icon-192.png'),
      font: getComputedStyle(document.body).fontFamily,
      imgs: [...document.querySelectorAll('img')].filter((i) => i.offsetParent !== null).map((i) => i.getAttribute('src')).slice(0, 40),
      coralText: [...document.querySelectorAll('a,span,label,p,div')]
        .filter((e) => e.offsetParent !== null && !e.closest('#aroomo-dock') && [...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()) && getComputedStyle(e).color === 'rgb(255, 127, 80)')
        .map((e) => e.innerText.slice(0, 20)),
    };
  });
  writeFileSync(path.join(out, `${label}-theme.json`), JSON.stringify(theme, null, 1));
  check(`${label} 主题色变量已覆盖为珊瑚色`, Object.keys(theme.vars).length > 0, Object.keys(theme.vars).slice(0, 8).join(','));
  const light = (c) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c); return Boolean(m && +m[1] >= 200 && +m[2] >= 200 && +m[3] >= 200); };
  check(`${label} 珊瑚色按钮上的字是深色`, theme.coralButtons.every((b) => !light(b.color)), JSON.stringify(theme.coralButtons.slice(0, 3)));
  check(`${label} 白底上没有浅珊瑚色文字`, theme.coralText.length === 0, JSON.stringify(theme.coralText.slice(0, 3)));
  check(`${label} PWA theme_color 是珊瑚色`, theme.themeColor === '#ff7f50', theme.themeColor);
  check(`${label} 默认助理头像 / PWA 图标是 Aroomo 的`, theme.lobeAvatar === theme.aroomoAvatar && theme.appIcon === theme.aroomoIcon, `${theme.lobeAvatar}/${theme.aroomoAvatar} ${theme.appIcon}/${theme.aroomoIcon}`);
  check(`${label} 苹果式系统字体`, /apple-system|PingFang|Microsoft YaHei UI/.test(theme.font), theme.font);
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
  if (!isMobile) {
    // —— 功能：填 Key → 成员自动出现并成为负责人；收件箱重要确认；删 Key 走确认卡（D63/D73）——
    const fakeKey = ['placeholder', 'sk', 'uie2e', 'ABCDEFGHIJKLMNOP'].join('-');
    await page.goto(`${base}/aroomo/members/keys`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name=sourceUrl]', 'https://platform.openai.com/api-keys');
    await page.fill('input[name=name]', '测试 Key');
    await page.fill('input[name=model]', 'openai/gpt-4o-mini');
    await page.fill('input[name=apiKey]', fakeKey);
    await page.click('#add-key summary');
    await page.fill('input[name=modelName]', 'GPT-4o mini');
    await page.click('#add-key button.primary');
    const keyRow = page.locator('.row', { hasText: '测试 Key' });
    await keyRow.waitFor({ timeout: 20000 }).catch(() => {});
    check('填 Key：列表只显示末 4 位', (await keyRow.count()) === 1 && (await keyRow.innerText()).includes('…' + fakeKey.slice(-4)), await page.locator('#tab').innerText().catch(() => ''));
    check('Key 明文不出现在页面', !(await page.content()).includes(fakeKey));
    await shoot(page, 'desktop-aroomo-keys');
    await page.goto(`${base}/aroomo/members`, { waitUntil: 'domcontentloaded' });
    const memberRow = page.locator('#mlist .row', { hasText: 'GPT-4o mini' });
    await memberRow.waitFor({ timeout: 10000 }).catch(() => {});
    check('填 Key 后模型自动成为成员并是负责人', (await memberRow.count()) === 1 && (await memberRow.innerText()).includes('负责人'), await page.locator('#tab').innerText().catch(() => ''));
    await shoot(page, 'desktop-aroomo-members-filled');

    const posted = await page.evaluate(() =>
      fetch('/aroomo/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aroomo-request': '1' },
        body: JSON.stringify({
          group: 'decision', kind: 'ui-e2e', title: '测试：要不要清空回收站', summary: '界面冒烟发的卡片',
          related: { type: 'test', id: 'ui-e2e' },
          actions: [{ id: 'yes', label: '清空', confirm: { kind: 'irreversible', consequences: ['回收站里的成员会被彻底删除，不能恢复。'] } }, { id: 'no', label: '不了' }],
        }),
      }).then((r) => r.status),
    );
    check('发收件箱卡片', posted === 201, posted);
    await page.goto(`${base}/aroomo/inbox`, { waitUntil: 'domcontentloaded' });
    await page.locator('.card', { hasText: '测试：要不要清空回收站' }).waitFor({ timeout: 10000 }).catch(() => {});
    await shoot(page, 'desktop-aroomo-inbox-card');
    await page.click('.card [data-action=yes]');
    const dialog = page.locator('.confirm');
    await dialog.waitFor({ timeout: 10000 }).catch(() => {});
    check('重要动作弹出确认卡并写明后果', (await dialog.count()) === 1 && (await dialog.innerText()).includes('不能恢复'));
    await shoot(page, 'desktop-confirm-card');
    await page.click('.confirm [data-step1]').catch(() => {});
    await page.waitForTimeout(500);
    const step2Disabled = await page.locator('.confirm [data-step2]').isDisabled().catch(() => false);
    check('第二次点击有 3 秒倒计时', step2Disabled);
    await page.waitForTimeout(3500);
    await page.click('.confirm [data-step2]').catch(() => {});
    await page.waitForTimeout(2000);
    check('确认后卡片处理完毕', (await page.locator('.card', { hasText: '测试：要不要清空回收站' }).count()) === 0, await page.locator('#page').innerText().catch(() => ''));

    await page.goto(`${base}/aroomo/members/keys`, { waitUntil: 'domcontentloaded' });
    await page.locator('.row [data-del]').first().click({ timeout: 10000 }).catch(() => {});
    await page.locator('.confirm').waitFor({ timeout: 10000 }).catch(() => {});
    await page.click('.confirm [data-step1]').catch(() => {});
    await page.waitForTimeout(3500);
    await page.click('.confirm [data-step2]').catch(() => {});
    await page.waitForTimeout(2500);
    check('删除 Key 走重要确认后删掉', (await page.locator('.row', { hasText: '测试 Key' }).count()) === 0);
  }

  if (!isMobile) {
    // —— 对话：填一个指向假模型的 Key，在 LobeHub 里说一句话（LobeHub → Core → LiteLLM → 模型，PRODUCT 16.1）——
    const k = await page.evaluate((fake) =>
      fetch('/aroomo/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aroomo-request': '1' },
        body: JSON.stringify({ name: '假模型', sourceUrl: 'https://example.com/keys', model: 'openai/fake-model', modelName: 'Fake Model', apiBase: 'http://fake-llm:8000/v1', apiKey: fake }),
      }).then((r) => r.status),
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
const required = /标题是 Aroomo|shell.js 已加载|跳回首页|跳到 Aroomo 设置|设置 6 个 Tab|朗读接口禁用|登录接口|填 Key|Key 明文|对话：|自动成为成员|发收件箱卡片|确认卡|倒计时|处理完毕|删除 Key/;
const hard = failed.filter((c) => required.test(c.name));
console.log(`\n${checks.length - failed.length}/${checks.length} 通过；必须项失败 ${hard.length}`);
process.exit(hard.length ? 1 : 0);
