/*
 * Aroomo Shell：注入到官方 LobeHub 页面里的薄层（D69：不改上游代码，只在浏览器里覆盖）。
 * 1. 朗读（TTS）禁用（D68）  2. 隐藏 PRODUCT §8 没列的页面和入口（D68，隐藏不删除）
 * 3. 品牌替换为 Aroomo（主人设计的 Logo）  4. 侧栏底部图标：Aroomo 标志、收藏、成员、收件箱（未读点）、设置（§8.2、§8.3）
 * 5. 主题色：珊瑚色 #ff7f50（覆盖页面上的主色变量；填充上的字用深色，保证对比度）
 * 6. 首页：上游吉祥物（运营素材图）换成 Aroomo 标志；隐藏 §8 没有的上游推广条（「上新」模型条、「推荐」卡）（D68 隐藏不删除）
 * 规则与 shell/src/rules.ts 保持一致（测试会核对）。
 */
(function () {
  'use strict';
  if (window.__aroomoShell) return;
  window.__aroomoShell = true;

  var HIDDEN_PREFIXES = ['community', 'discover', 'image', 'video', 'page', 'resource', 'memory', 'tasks', 'task', 'eval', 'goal', 'goals', 'dashboard', 'labs', 'devices', 'channel', 'connector', 'skill', 'mcp', 'changelog'];
  var REDIRECTS = { settings: '/aroomo/settings', me: '/aroomo/settings', profile: '/aroomo/settings/account' };

  /* 文案替换：品牌、默认助理 → 资源管家（§8.3 资源管家私聊固定置顶） */
  var TEXT_RULES = [
    [/LobeHub|LobeChat|Lobe Chat/g, 'Aroomo'],
    [/Lobe[\s\u00a0]?AI/g, '资源管家'],
    [/在同一工作区协作，把想法推进成结果/g, '交给我，我来安排合适的成员'],
  ];

  /* 要隐藏的入口（按完整文字匹配，中英文都列） */
  var HIDE_LABELS = [
    // §8 没有的页面
    '社区', '发现', '市场', '图片', '视频', '文稿', '资源', '资源库', '记忆', '任务', '看板', '评测实验室', '生成', '创建', '音频',
    'Community', 'Discover', 'Marketplace', 'Image', 'Images', 'Video', 'Videos', 'Pages', 'Resource', 'Resources', 'Memory', 'Tasks', 'Dashboard', 'Eval Lab', 'Create', 'Audio',
    // 上游的帮助 / 社区 / 计费入口
    '使用文档', '帮助中心', '联系我们', '邮件支持', 'Discord', '社区版', '账单', '订阅方案', '积分', '升级套餐', '邀请好友', '更新日志', '我的用量',
    'Docs', 'Help Center', 'Contact Us', 'Email Support', 'Changelog', 'Billing', 'Plans', 'Credits', 'Upgrade', 'Invite Friends',
    // 设置入口统一到 Aroomo 设置（底部图标）
    '应用设置', '账户设置', '账户管理', '设置', 'Settings', 'App Settings', 'Account Settings',
    // D68 朗读：所有入口与设置
    '朗读', '语音朗读', '语音服务', '语音合成', '语音合成设置', '语音合成服务', '语音合成声源', '试听声源', '文本转语音', 'TTS', 'Read Aloud', 'Text to Speech',
    'Lobe 答疑助手',
  ];
  /* 整行隐藏（文字所在元素的父元素一起藏）：上游的匿名数据开关、指向上游条款的说明 */
  var HIDE_ROW_PREFIXES = ['一起让 Aroomo 变得更好', '我们使用匿名数据持续优化体验', '我们仅收集匿名数据', 'Help us improve Aroomo', 'We use anonymous data'];
  var HIDE_SET = {};
  HIDE_LABELS.forEach(function (l) { HIDE_SET[l] = true; });

  /* 主人设计的 Aroomo 标志（单色，跟随文字颜色，深浅模式都清楚）。源文件：assets/brand/logo-web-black.svg */
  var LOGO_SVG = '<svg viewBox="162 162 700 700" aria-hidden="true" focusable="false"><path d="M181.5 397.9 A349.6 349.6 0 1 1 181.5 626.1 H514.6 A114.1 114.1 0 0 0 514.6 397.9 Z" fill="currentColor" /><g transform="translate(-32.1437245262 0)"><circle cx="260.7" cy="512.0" r="66.2" fill="currentColor" /><rect x="326.9" y="445.8" width="132.5" height="132.5" rx="23.8" fill="currentColor" /><path d="M591.9 512.0 L591.8 513.7 L591.5 515.5 L591.0 517.1 L590.4 518.8 L589.5 520.4 L588.6 522.0 L587.5 523.5 L586.3 524.9 L585.1 526.3 L583.8 527.6 L582.5 528.8 L581.1 530.0 L579.8 531.2 L578.5 532.3 L577.3 533.4 L576.2 534.5 L575.1 535.6 L574.2 536.7 L573.3 537.9 L572.6 539.1 L571.9 540.4 L571.3 541.7 L570.8 543.1 L570.4 544.5 L570.0 546.1 L569.7 547.7 L569.3 549.3 L569.0 551.0 L568.6 552.8 L568.2 554.6 L567.7 556.4 L567.2 558.1 L566.5 559.9 L565.7 561.5 L564.9 563.2 L563.9 564.7 L562.8 566.0 L561.5 567.3 L560.2 568.4 L558.7 569.4 L557.2 570.1 L555.6 570.8 L553.9 571.2 L552.1 571.5 L550.3 571.6 L548.5 571.5 L546.6 571.3 L544.8 571.0 L543.0 570.6 L541.2 570.2 L539.5 569.6 L537.7 569.1 L536.1 568.5 L534.5 568.0 L532.9 567.5 L531.4 567.0 L529.9 566.7 L528.5 566.4 L527.0 566.3 L525.6 566.2 L524.2 566.3 L522.8 566.4 L521.3 566.7 L519.8 567.0 L518.3 567.5 L516.8 568.0 L515.1 568.5 L513.5 569.1 L511.8 569.6 L510.0 570.2 L508.2 570.6 L506.4 571.0 L504.6 571.3 L502.8 571.5 L500.9 571.6 L499.1 571.5 L497.4 571.2 L495.7 570.8 L494.0 570.1 L492.5 569.4 L491.0 568.4 L489.7 567.3 L488.5 566.0 L487.4 564.7 L486.4 563.2 L485.5 561.5 L484.7 559.9 L484.1 558.1 L483.5 556.4 L483.0 554.6 L482.6 552.8 L482.2 551.0 L481.9 549.3 L481.6 547.7 L481.2 546.1 L480.8 544.5 L480.4 543.1 L479.9 541.7 L479.3 540.4 L478.7 539.1 L477.9 537.9 L477.1 536.7 L476.1 535.6 L475.1 534.5 L473.9 533.4 L472.7 532.3 L471.4 531.2 L470.1 530.0 L468.8 528.8 L467.5 527.6 L466.1 526.3 L464.9 524.9 L463.7 523.5 L462.6 522.0 L461.7 520.4 L460.9 518.8 L460.2 517.1 L459.8 515.5 L459.5 513.7 L459.4 512.0 L459.5 510.3 L459.8 508.5 L460.2 506.9 L460.9 505.2 L461.7 503.6 L462.6 502.0 L463.7 500.5 L464.9 499.1 L466.1 497.7 L467.5 496.4 L468.8 495.2 L470.1 494.0 L471.4 492.8 L472.7 491.7 L473.9 490.6 L475.1 489.5 L476.1 488.4 L477.1 487.3 L477.9 486.1 L478.7 484.9 L479.3 483.6 L479.9 482.3 L480.4 480.9 L480.8 479.5 L481.2 477.9 L481.6 476.3 L481.9 474.7 L482.2 473.0 L482.6 471.2 L483.0 469.4 L483.5 467.6 L484.1 465.9 L484.7 464.1 L485.5 462.5 L486.4 460.8 L487.4 459.3 L488.5 458.0 L489.7 456.7 L491.0 455.6 L492.5 454.6 L494.0 453.9 L495.7 453.2 L497.4 452.8 L499.1 452.5 L500.9 452.4 L502.8 452.5 L504.6 452.7 L506.4 453.0 L508.2 453.4 L510.0 453.8 L511.8 454.4 L513.5 454.9 L515.1 455.5 L516.8 456.0 L518.3 456.5 L519.8 457.0 L521.3 457.3 L522.8 457.6 L524.2 457.7 L525.6 457.8 L527.0 457.7 L528.5 457.6 L529.9 457.3 L531.4 457.0 L532.9 456.5 L534.5 456.0 L536.1 455.5 L537.7 454.9 L539.5 454.4 L541.2 453.8 L543.0 453.4 L544.8 453.0 L546.6 452.7 L548.5 452.5 L550.3 452.4 L552.1 452.5 L553.9 452.8 L555.6 453.2 L557.2 453.9 L558.7 454.6 L560.2 455.6 L561.5 456.7 L562.8 458.0 L563.9 459.3 L564.9 460.8 L565.7 462.5 L566.5 464.1 L567.2 465.9 L567.7 467.6 L568.2 469.4 L568.6 471.2 L569.0 473.0 L569.3 474.7 L569.7 476.3 L570.0 477.9 L570.4 479.5 L570.8 480.9 L571.3 482.3 L571.9 483.6 L572.6 484.9 L573.3 486.1 L574.2 487.3 L575.1 488.4 L576.2 489.5 L577.3 490.6 L578.5 491.7 L579.8 492.8 L581.1 494.0 L582.5 495.2 L583.8 496.4 L585.1 497.7 L586.3 499.1 L587.5 500.5 L588.6 502.0 L589.5 503.6 L590.4 505.2 L591.0 506.9 L591.5 508.5 L591.8 510.3Z" fill="currentColor" /></g></svg>';

  /* ---------- 1. 朗读禁用（D68：隐藏且禁用） ---------- */
  try {
    if (window.speechSynthesis) {
      var noop = function () {};
      window.speechSynthesis.speak = noop;
    }
  } catch (e) { /* 忽略 */ }
  var TTS_URL = /\/webapi\/tts\/|speech\.platform\.bing\.com|tts\.speech\.microsoft\.com|texttospeech/i;
  try {
    var OrigWS = window.WebSocket;
    var PatchedWS = function (url, protocols) {
      if (TTS_URL.test(String(url))) throw new Error('朗读功能已关闭');
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    PatchedWS.prototype = OrigWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { PatchedWS[k] = OrigWS[k]; });
    window.WebSocket = PatchedWS;
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (TTS_URL.test(String(u))) return Promise.reject(new Error('朗读功能已关闭'));
      return origFetch.call(this, input, init);
    };
  } catch (e) { /* 忽略 */ }

  /* ---------- 2. 路由：隐藏的页面跳回首页，设置跳到 Aroomo 设置 ---------- */
  function decide(pathname) {
    var first = String(pathname || '/').split('/').filter(Boolean)[0] || '';
    if (Object.prototype.hasOwnProperty.call(REDIRECTS, first)) return { full: REDIRECTS[first] };
    if (HIDDEN_PREFIXES.indexOf(first) >= 0) return { spa: '/' };
    return null;
  }
  function guard() {
    var d = decide(location.pathname);
    if (!d) return;
    if (d.full) location.assign(d.full);
    else if (d.spa) {
      history.replaceState(history.state, '', d.spa);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(guard, 0);
      return r;
    };
  });
  window.addEventListener('popstate', function () { setTimeout(guard, 0); });
  guard();
  window.__aroomoDecide = decide;

  /* ---------- 3. 品牌 + 隐藏入口 ---------- */
  function replaceText(s) {
    var out = s;
    for (var i = 0; i < TEXT_RULES.length; i++) out = out.replace(TEXT_RULES[i][0], TEXT_RULES[i][1]);
    return out;
  }
  var ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
  var CLICKABLE = 'a,button,[role="button"],[role="menuitem"],[role="tab"],[role="option"],li';

  function hideEntry(el) {
    // 找到最近的可点击祖先（最多 6 层）；没有就隐藏文字所在的元素
    var target = el.closest ? el.closest(CLICKABLE) : null;
    if (!target) {
      var p = el, depth = 0;
      while (p && depth < 3 && p.parentElement && p.parentElement.children.length === 1) { p = p.parentElement; depth++; }
      target = p;
    }
    if (target && target !== document.body && !target.closest('#aroomo-dock')) target.setAttribute('data-aroomo-hidden', '');
  }

  function processNode(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      var v = root.nodeValue;
      if (!v) return;
      var r = replaceText(v);
      if (r !== v) root.nodeValue = r;
      var t = r.trim();
      if (t && HIDE_SET[t] && root.parentElement) hideEntry(root.parentElement);
      if (t && root.parentElement) {
        for (var h = 0; h < HIDE_ROW_PREFIXES.length; h++) {
          if (t.indexOf(HIDE_ROW_PREFIXES[h]) === 0) {
            var row = root.parentElement.parentElement || root.parentElement;
            if (row !== document.body) row.setAttribute('data-aroomo-hidden', '');
          }
        }
      }
      return;
    }
    if (root.nodeType !== 1) return;
    if (root.id === 'aroomo-dock' || root.tagName === 'SCRIPT' || root.tagName === 'STYLE' || root.isContentEditable) return;
    // 消息正文、输入框里的文字不动（用户和模型写的内容保持原样）
    if (root.closest && root.closest('[contenteditable="true"],textarea,.markdown,article,[data-message-id]')) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = root.getAttribute && root.getAttribute(ATTRS[i]);
      if (a) {
        var ra = replaceText(a);
        if (ra !== a) root.setAttribute(ATTRS[i], ra);
        if (HIDE_SET[ra.trim()] && root.matches && root.matches(CLICKABLE)) root.setAttribute('data-aroomo-hidden', '');
      }
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    var list = [];
    while ((n = walker.nextNode())) list.push(n);
    for (var j = 0; j < list.length; j++) {
      var pe = list[j].parentElement;
      if (pe && pe.closest('[contenteditable="true"],textarea,.markdown,article,[data-message-id],#aroomo-dock,script,style')) continue;
      processNode(list[j]);
    }
    var withAttr = root.querySelectorAll ? root.querySelectorAll('[title],[aria-label],[placeholder],[alt]') : [];
    for (var k = 0; k < withAttr.length; k++) {
      var el = withAttr[k];
      if (el.closest('[contenteditable="true"],.markdown,article,[data-message-id],#aroomo-dock')) continue;
      for (var q = 0; q < ATTRS.length; q++) {
        var av = el.getAttribute(ATTRS[q]);
        if (!av) continue;
        var rv = replaceText(av);
        if (rv !== av) el.setAttribute(ATTRS[q], rv);
        if (HIDE_SET[rv.trim()] && el.matches(CLICKABLE)) el.setAttribute('data-aroomo-hidden', '');
      }
    }
  }

  function fixTitle() {
    var t = document.title;
    var r = replaceText(t);
    if (r !== t) document.title = r;
  }

  /* ---------- 4. 侧栏底部图标（§8.2：📥 收藏、👥 成员、🔔 收件箱、⚙ 设置） ---------- */
  var ICONS = {
    favorites: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    members: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.8c1.9.6 3.2 2.3 3.5 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };
  var DOCK_ITEMS = [
    { id: 'favorites', label: '收藏', href: '/aroomo/favorites' },
    { id: 'members', label: '成员', href: '/aroomo/members' },
    { id: 'inbox', label: '收件箱', href: '/aroomo/inbox' },
    { id: 'settings', label: '设置', href: '/aroomo/settings' },
  ];

  function buildDock() {
    if (document.getElementById('aroomo-dock')) return;
    var nav = document.createElement('nav');
    nav.id = 'aroomo-dock';
    nav.setAttribute('aria-label', 'Aroomo');
    var brand = document.createElement('a');
    brand.href = '/';
    brand.className = 'aroomo-dock-item aroomo-dock-brand';
    brand.setAttribute('aria-label', 'Aroomo 首页');
    brand.title = 'Aroomo';
    brand.innerHTML = LOGO_SVG + '<span class="aroomo-dock-label">Aroomo 首页</span>';
    nav.appendChild(brand);
    DOCK_ITEMS.forEach(function (it) {
      var a = document.createElement('a');
      a.href = it.href;
      a.className = 'aroomo-dock-item';
      a.setAttribute('data-aroomo-dock', it.id);
      a.setAttribute('aria-label', it.label);
      a.title = it.label;
      a.innerHTML = ICONS[it.id] + '<span class="aroomo-dock-label">' + it.label + '</span>' + (it.id === 'inbox' ? '<span class="aroomo-dot" hidden></span>' : '');
      nav.appendChild(a);
    });
    document.body.appendChild(nav);
  }

  /* 找到 LobeHub 的左侧栏：左下角那一列、高度接近整屏、宽度 160–420 的元素 */
  function findSidebar() {
    var x = 12, y = window.innerHeight - 12;
    var el = document.elementFromPoint(x, y);
    var best = null;
    while (el && el !== document.body) {
      if (el.id !== 'aroomo-dock') {
        var r = el.getBoundingClientRect();
        if (r.left <= 1 && r.width >= 160 && r.width <= 420 && r.height >= window.innerHeight * 0.8) best = el;
      }
      el = el.parentElement;
    }
    return best;
  }

  function placeDock() {
    var dock = document.getElementById('aroomo-dock');
    if (!dock) return;
    var mobile = window.innerWidth < 768;
    dock.classList.toggle('aroomo-dock-mobile', mobile);
    if (mobile) {
      dock.style.left = '';
      dock.style.width = '';
      // 手机：底部图标只在会话列表（首页）显示，进入对话后不挡输入框（§8.2 手机端参照 Grok）
      dock.hidden = location.pathname !== '/';
      return;
    }
    // 登录 / 注册页不显示（会挡住上游的语言切换）
    var first = location.pathname.split('/').filter(Boolean)[0] || '';
    if (/^(signin|signup|login|auth|verify-email|reset-password|forgot-password)$/.test(first)) {
      dock.hidden = true;
      return;
    }
    var side = findSidebar();
    if (side) {
      var r = side.getBoundingClientRect();
      dock.style.left = Math.max(0, r.left) + 'px';
      dock.style.width = r.width + 'px';
      dock.hidden = false;
      document.documentElement.style.setProperty('--aroomo-dock-h', dock.offsetHeight + 'px');
    } else {
      // 侧栏收起时：缩成左下角一列
      dock.style.left = '0px';
      dock.style.width = '';
    }
  }

  var unreadTimer = null;
  function refreshUnread() {
    var dot = document.querySelector('#aroomo-dock .aroomo-dot');
    if (!dot) return;
    origFetchSafe('/aroomo/api/inbox/unread-count', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && typeof j.total === 'number' ? j.total : 0;
        dot.hidden = !n;
        var a = dot.parentElement;
        if (a) a.setAttribute('aria-label', n ? '收件箱，' + n + ' 条未读' : '收件箱');
      })
      .catch(function () {});
  }
  function origFetchSafe(u, o) { return (window.__aroomoOrigFetch || window.fetch)(u, o); }

  /* 逐字动画的标题（每个字一个 span，例如「嘿，你好，我是 Lobe AI」）：整体替换 */
  var BRAND_TEST = /LobeHub|LobeChat|Lobe Chat|Lobe[\s\u00a0]?AI/;
  /* 一个元素是不是「逐字拆开的标题」：文字不长，所有后代都是 span，最底层每个 span 只有 1–2 个字 */
  function isSplitHeading(el) {
    if (!el || el.nodeType !== 1 || el.closest('.markdown,article,[data-message-id],[contenteditable="true"],#aroomo-dock')) return false;
    var tc = (el.textContent || '').replace(/\s+/g, ' ');
    if (tc.length > 80 || !BRAND_TEST.test(tc)) return false;
    var all = el.querySelectorAll('*');
    if (all.length < 4) return false;
    for (var k = 0; k < all.length; k++) {
      var c = all[k];
      if (c.tagName !== 'SPAN') return false;
      if (!c.children.length && (c.textContent || '').length > 2) return false;
    }
    return true;
  }
  function fixSplitText(root) {
    if (!root) return;
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root || !root.querySelectorAll) return;
    /* 逐字动画会一个字一个字地加 span：往上找几层祖先，找到整句后整体替换 */
    var up = root;
    for (var a = 0; a < 4 && up && up !== document.body; a++, up = up.parentElement) {
      if (isSplitHeading(up)) { up.textContent = replaceText(up.textContent || ''); return; }
    }
    var els = root.querySelectorAll('h1,h2,h3,h4,p,div,span');
    for (var i = 0; i < els.length; i++) {
      if (isSplitHeading(els[i])) els[i].textContent = replaceText(els[i].textContent || '');
    }
  }

  /* 上游 Logo 换成 Aroomo 的：
   *  a) 宽扁的文字 Logo（页面顶部）→ Aroomo 标志 + 字
   *  b) 带 <title>LobeHub</title> 的品牌 SVG（登录页等）→ Aroomo 标志
   *  c) 上游品牌图片（3D Logo、Lobe AI 吉祥物、PWA 图标）→ Aroomo 图标 */
  var BRAND_IMG = /assets-logo|logo-3d|overview-cao|lobe-ai\.png|\/app-icons\/|lobehub[^/]*\/(?:.*\/)?(?:logo|icon)/i;
  function makeMark(h, withText) {
    var mark = document.createElement('span');
    mark.className = 'aroomo-wordmark';
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'Aroomo');
    if (h) mark.style.height = Math.round(h) + 'px';
    if (!withText && h) mark.style.fontSize = Math.round(h / 1.3) + 'px';
    mark.innerHTML = LOGO_SVG + (withText ? '<span aria-hidden="true">Aroomo</span>' : '');
    return mark;
  }
  function fixLogos() {
    var svgs = document.querySelectorAll('svg:not(.lucide):not([data-aroomo-logo])');
    for (var i = 0; i < svgs.length; i++) {
      var svg = svgs[i];
      if (svg.closest('#aroomo-dock,.aroomo-wordmark,.markdown,article,[data-message-id]')) continue;
      var r = svg.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var t = svg.querySelector('title');
      var branded = t && /Lobe/i.test(t.textContent || '');
      var wide = r.top <= 140 && r.width >= 50 && r.width <= 220 && r.width / r.height >= 2.2;
      if (!branded && !wide) continue;
      svg.setAttribute('data-aroomo-logo', '');
      svg.style.display = 'none';
      svg.parentNode.insertBefore(makeMark(r.height, wide), svg);
    }
    var imgs = document.querySelectorAll('img:not([data-aroomo-logo-img])');
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      var src = img.getAttribute('src') || '';
      if (!BRAND_IMG.test(src) || img.closest('.markdown,article,[data-message-id]')) continue;
      img.setAttribute('data-aroomo-logo-img', '');
      img.removeAttribute('srcset');
      // 首页的大吉祥物插画 → Aroomo 标志（透明底、跟随深浅色）；其余 → Aroomo 图标
      img.src = /overview-cao/i.test(src) ? '/aroomo/static/logo.svg' : '/aroomo/static/avatar.png';
    }
    fixMascots();
  }

  /* ---------- 6. 首页：上游吉祥物、推广条（§8 没有；D68 隐藏不删除，D69 只在浏览器里覆盖） ---------- */
  /* 上游运营素材（首页挥手吉祥物等）：按域名 + 路径前缀匹配，不按文件名（上游会换图） */
  var OPS_ASSET = /^(?:https?:)?\/\/chat-cloud\.lobeobjects\.space\/dc\/ops-assets\//i;
  var MASCOT_SRC = '/aroomo/static/logo.svg';
  function fixMascots() {
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      if (!OPS_ASSET.test(src) && !OPS_ASSET.test(img.currentSrc || '')) continue;
      if (img.closest('.markdown,article,[data-message-id]')) continue;
      img.setAttribute('data-aroomo-mascot', '');
      img.removeAttribute('srcset');
      img.setAttribute('alt', 'Aroomo');
      img.src = MASCOT_SRC;
    }
    var sources = document.querySelectorAll('picture source[srcset]');
    for (var k = 0; k < sources.length; k++) {
      if (OPS_ASSET.test(sources[k].getAttribute('srcset') || '')) sources[k].remove();
    }
  }

  /* 首页推广条：「上新」模型广告条、「推荐」上游功能推荐卡。只在首页处理，避免误伤对话里的同名文字 */
  var PROMO_LABELS = { '上新': 'strip', '推荐': 'card' };
  var FORM_SEL = 'textarea,[contenteditable="true"],input,#aroomo-dock';
  function isHome() {
    var p = location.pathname.replace(/\/+$/, '');
    return p === '' || p === '/home';
  }
  function promoBox(label, kind) {
    var el = label.parentElement;
    for (var d = 0; el && el !== document.body && d < 8; d++, el = el.parentElement) {
      if (el.querySelector(FORM_SEL)) return null; // 到了输入框那一层还没找到：不动
      var r = el.getBoundingClientRect();
      if (r.height > 480) return null;
      if (kind === 'strip' && el.querySelectorAll('button,[role="button"]').length >= 2) return el;
      if (kind === 'card' && r.height >= 80 && r.width >= 160 && el.querySelectorAll('*').length >= 6) return el;
    }
    return null;
  }
  function hidePromos() {
    if (!isHome()) return;
    var main = document.querySelector('main') || document.body;
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, null);
    var n;
    var found = [];
    while ((n = walker.nextNode())) {
      var t = (n.nodeValue || '').trim();
      if (PROMO_LABELS[t] && n.parentElement && !n.parentElement.closest('[data-aroomo-hidden],.markdown,article,[data-message-id],#aroomo-dock')) found.push(n);
    }
    for (var i = 0; i < found.length; i++) {
      var box = promoBox(found[i].parentElement, PROMO_LABELS[found[i].nodeValue.trim()]);
      if (box) box.setAttribute('data-aroomo-hidden', '');
    }
  }

  /* ---------- 5. 主题色（珊瑚色）：扫描页面样式表里实际定义的主色变量，按名字覆盖（!important，原选择器不变） ---------- */
  var THEME = {
    light: { base: '#ff7f50', hover: '#ff936b', active: '#e8693c', bg: '#fff3ee', bghover: '#ffe6dc', border: '#ffcdb8', borderhover: '#ffb293', text: '#b4441b', texthover: '#c2532a', textactive: '#9a3a17' },
    dark: { base: '#ff7f50', hover: '#ff9a73', active: '#e5673b', bg: 'rgba(255,127,80,0.16)', bghover: 'rgba(255,127,80,0.24)', border: 'rgba(255,127,80,0.45)', borderhover: 'rgba(255,127,80,0.6)', text: '#ff9a73', texthover: '#ffad8f', textactive: '#ff7f50' },
  };
  function themeValue(name, dark) {
    var n = name.toLowerCase().replace(/-/g, '');
    var link = n.indexOf('colorlink') >= 0;
    var i = link ? n.indexOf('colorlink') + 9 : n.indexOf('primary') + 7;
    var rest = n.slice(i);
    if (/solid|textlight|^s?\d|shadow|outline/.test(rest)) return null; // 填充上的字色、数字色阶（色板）不动
    var t = dark ? THEME.dark : THEME.light;
    if (link) return rest === 'hover' ? t.texthover : rest === 'active' ? t.textactive : rest === '' ? t.text : null;
    if (rest in t) return t[rest];
    if (rest === '') return t.base;
    if (rest.indexOf('text') === 0) return t.text;
    if (rest.indexOf('bg') === 0 || rest.indexOf('fill') === 0) return t.bg;
    if (rest.indexOf('border') === 0) return t.border;
    return null;
  }
  function isDark() {
    var h = document.documentElement;
    var a = (h.getAttribute('data-theme') || '') + ' ' + h.className;
    if (/\bdark\b/.test(a)) return true;
    if (/\blight\b/.test(a)) return false;
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor || '');
    if (m && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(getComputedStyle(document.body).backgroundColor)) return (+m[1] + +m[2] + +m[3]) / 3 < 100;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  }
  var themeFound = {};
  window.__aroomoThemeVars = themeFound;
  function collect(rules, out) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.cssRules && !r.style) { collect(r.cssRules, out); continue; }
      if (!r.style || !r.selectorText || r.selectorText.indexOf('aroomo') >= 0) continue;
      for (var k = 0; k < r.style.length; k++) {
        var prop = r.style[k];
        if (prop.charCodeAt(0) !== 45 || prop.charCodeAt(1) !== 45) continue;
        var low = prop.toLowerCase();
        if (low.indexOf('primary') < 0 && !/color-?link/.test(low)) continue;
        if (low.indexOf('color') < 0) continue;
        (out[r.selectorText] = out[r.selectorText] || {})[prop] = true;
      }
      if (r.cssRules) collect(r.cssRules, out);
    }
  }
  var lastThemeCss = '';
  function applyTheme() {
    var found = {};
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i];
      if (sh.ownerNode && sh.ownerNode.id === 'aroomo-theme') continue;
      try { collect(sh.cssRules || [], found); } catch (e) { /* 跨域样式表读不了，跳过 */ }
    }
    var dark = isDark();
    var css = '';
    for (var sel in found) {
      var decl = '';
      for (var prop in found[sel]) {
        var v = themeValue(prop, dark);
        if (v) { decl += prop + ':' + v + ' !important;'; themeFound[prop] = v; }
      }
      if (decl) css += sel + '{' + decl + '}\n';
    }
    if (css === lastThemeCss) return;
    lastThemeCss = css;
    var st = document.getElementById('aroomo-theme');
    if (!st) {
      st = document.createElement('style');
      st.id = 'aroomo-theme';
    }
    st.textContent = css;
    // 放在 <head> 最后，顺序也压过前面的样式
    document.head.appendChild(st);
    markOnCoral(document.body);
  }
  /* 对比度（主人低视力）：
   *  珊瑚色填充上的浅色字（对比度约 2.5:1，不合格）→ data-aroomo-oncoral，CSS 改成深色字
   *  白底上的珊瑚色文字（#ff7f50 只有 2.5:1）→ data-aroomo-coraltext，CSS 改成深珊瑚 #b4441b */
  var CORAL = /rgb\((255, 127, 80|255, 147, 107|232, 105, 60|255, 154, 115|229, 103, 59)\)/;
  function isLight(c) {
    var m = /rgba?\((\d+), (\d+), (\d+)/.exec(c);
    return Boolean(m && +m[1] >= 200 && +m[2] >= 200 && +m[3] >= 200);
  }
  function markOnCoral(root) {
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll('button,[role="button"],a,label,span');
    var dark = null;
    for (var i = 0, n = 0; i < els.length && n < 400; i++) {
      var el = els[i];
      if (el.closest('#aroomo-dock,.markdown,article,[data-message-id]')) continue;
      n++;
      var cs = getComputedStyle(el);
      var onFill = CORAL.test(cs.backgroundColor);
      if (onFill && isLight(cs.color)) el.setAttribute('data-aroomo-oncoral', '');
      else if (!onFill && el.hasAttribute('data-aroomo-oncoral')) el.removeAttribute('data-aroomo-oncoral');
      if (!onFill && !el.hasAttribute('data-aroomo-coraltext') && /rgb\(255, 127, 80\)/.test(cs.color)) {
        if (dark === null) dark = isDark();
        if (!dark) el.setAttribute('data-aroomo-coraltext', '');
      }
    }
  }
  var themeTimer = null;
  function scheduleTheme() {
    if (themeTimer) return;
    themeTimer = setTimeout(function () { themeTimer = null; applyTheme(); }, 250);
  }

  var pending = false;
  var queue = [];
  function flush() {
    pending = false;
    var nodes = queue;
    queue = [];
    for (var i = 0; i < nodes.length; i++) {
      processNode(nodes[i]);
      fixSplitText(nodes[i].nodeType === 1 ? nodes[i] : nodes[i].parentElement);
      if (nodes[i].nodeType === 1) markOnCoral(nodes[i]);
    }
    fixLogos();
    hidePromos();
    fixTitle();
    placeDock();
  }
  function schedule(n) {
    queue.push(n);
    if (!pending) {
      pending = true;
      (window.requestAnimationFrame || setTimeout)(flush, 16);
    }
  }

  function start() {
    document.documentElement.setAttribute('data-aroomo', '');
    buildDock();
    processNode(document.body);
    fixSplitText(document.body);
    fixLogos();
    hidePromos();
    fixTitle();
    placeDock();
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') schedule(m.target);
        else if (m.type === 'attributes') schedule(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['src', 'srcset']) });
    // 主题：页面加载后几次（CSS-in-JS 的样式是陆续插入的），<head> 里加样式、深浅模式切换时再算
    applyTheme();
    [800, 2500, 6000].forEach(function (ms) { setTimeout(applyTheme, ms); });
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') return scheduleTheme();
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.id !== 'aroomo-theme' && (n.tagName === 'STYLE' || n.tagName === 'LINK')) return scheduleTheme();
        }
      }
    }).observe(document.head, { childList: true });
    new MutationObserver(scheduleTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', scheduleTheme);
    }
    var titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(fixTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });
    window.addEventListener('resize', placeDock);
    setInterval(placeDock, 1000);
    refreshUnread();
    unreadTimer = setInterval(refreshUnread, 60000);
  }
  window.__aroomoOrigFetch = window.fetch;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  void unreadTimer;
})();
