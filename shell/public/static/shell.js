/*
 * Aroomo Shell：注入到官方 LobeHub 页面里的薄层（D69：不改上游代码，只在浏览器里覆盖）。
 * 1. 朗读（TTS）禁用（D68）  2. 隐藏 PRODUCT §8 没列的页面和入口（D68，隐藏不删除）
 * 3. 品牌替换为 Aroomo       4. 侧栏底部图标：收藏、成员、收件箱（红点）、设置（§8.2、§8.3）
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

  /* 上游的文字 Logo（宽扁的 SVG，在页面顶部）换成 Aroomo 字标 */
  function fixLogos() {
    var svgs = document.querySelectorAll('svg:not(.lucide):not([data-aroomo-logo])');
    for (var i = 0; i < svgs.length; i++) {
      var svg = svgs[i];
      if (svg.closest('#aroomo-dock,.markdown,article,[data-message-id]')) continue;
      var r = svg.getBoundingClientRect();
      if (!r.width || !r.height || r.top > 140 || r.width < 50 || r.width > 220) continue;
      if (r.width / r.height < 2.2) continue;
      svg.setAttribute('data-aroomo-logo', '');
      svg.style.display = 'none';
      var mark = document.createElement('span');
      mark.className = 'aroomo-wordmark';
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', 'Aroomo');
      mark.style.height = Math.round(r.height) + 'px';
      mark.innerHTML = '<img src="/aroomo/static/logo.svg" alt="">Aroomo';
      svg.parentNode.insertBefore(mark, svg);
    }
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
    }
    fixLogos();
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
    fixTitle();
    placeDock();
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') schedule(m.target);
        else if (m.type === 'attributes') schedule(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
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
