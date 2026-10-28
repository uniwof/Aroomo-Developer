/*
 * Aroomo：输入框 @ 联想 Aroomo 成员（PRODUCT §8.3「输入框：@ 联想成员」；DECISIONS H3 最小改动方案：
 * Shell 给 LobeHub 输入框加一个 Aroomo 自己的联想浮层，不改上游代码，D69）。
 *
 * - 在对话输入框里打「@」或「＠」后出现浮层，列出在职、启用的 Aroomo 成员（/aroomo/api/members，候选不列）；
 *   继续输入会按名字 / 别名筛选（大小写不敏感）。
 * - ↑ ↓ 选择，Enter / Tab 填入，Esc 关闭；鼠标点也可以。填入的是「@成员名 」，由 Core 按 D31 解析点名。
 * - 只用「删除 + 插入文字」这两种普通编辑操作改输入框（和用户自己打字一样），LobeHub 的编辑器状态保持一致。
 * - 输入法组字中不处理；浮层有 role=listbox，选中项 aria-selected；尊重「减少动效」。
 * 独立文件，不依赖 shell.js（避免与其他界面改动冲突）。
 */
(function () {
  'use strict';
  if (window.__aroomoMention) return;
  window.__aroomoMention = true;

  var AT_RE = /(^|[\s(（,，.。:：;；!！?？"'“”「」『』\[\]【】])[@＠]([^\s@＠]{0,32})$/;
  var MAX_ITEMS = 8;
  var CACHE_MS = 30000;

  var members = null;
  var fetchedAt = 0;
  var loading = null;
  var box = null;
  var live = null;
  var state = null; // { el, query, items, index }

  function loadMembers() {
    if (members && Date.now() - fetchedAt < CACHE_MS) return Promise.resolve(members);
    if (loading) return loading;
    var f = window.__aroomoOrigFetch || window.fetch;
    loading = f('/aroomo/api/members', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = (j && j.members) || [];
        members = list.filter(function (m) { return m && m.enabled && m.status !== 'candidate' && !m.deletedAt; });
        fetchedAt = Date.now();
        return members;
      })
      .catch(function () { return members || []; })
      .then(function (r) { loading = null; return r; });
    return loading;
  }

  function inputRoot(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return null;
    if (el.closest('#aroomo-mention')) return null;
    var host = el.closest('[contenteditable="true"],textarea');
    if (!host) return null;
    // 只处理对话输入框；找不到标记时退回：页面底部附近的可编辑区
    if (host.closest('[data-testid="chat-input"]')) return host;
    var r = host.getBoundingClientRect();
    return r.bottom > window.innerHeight * 0.5 ? host : null;
  }

  /* 光标前的文字 + 光标位置的矩形 */
  function caretInfo(el) {
    if (el.tagName === 'TEXTAREA') {
      var pos = el.selectionStart;
      if (pos !== el.selectionEnd) return null;
      var tr = el.getBoundingClientRect();
      return { before: el.value.slice(Math.max(0, pos - 64), pos), rect: { left: tr.left + 12, top: tr.top } };
    }
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    if (!el.contains(node)) return null;
    var before = '';
    if (node.nodeType === 3) before = node.nodeValue.slice(0, range.startOffset);
    else return { before: '', rect: el.getBoundingClientRect() };
    var rect = null;
    try {
      var rr = range.getClientRects();
      rect = rr.length ? rr[0] : null;
    } catch (e) { rect = null; }
    if (!rect || (!rect.left && !rect.top)) rect = el.getBoundingClientRect();
    return { before: before.slice(-64), rect: rect };
  }

  function score(m, q) {
    if (!q) return 1;
    var names = [m.name].concat(m.aliases || []);
    var best = 0;
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i]).toLowerCase();
      if (n.indexOf(q) === 0) best = Math.max(best, 3);
      else if (n.split(/[\s\-_.]+/).some(function (w) { return w.indexOf(q) === 0; })) best = Math.max(best, 2);
      else if (n.indexOf(q) >= 0) best = Math.max(best, 1);
    }
    return best;
  }

  function filter(list, q) {
    q = (q || '').toLowerCase();
    return list
      .map(function (m) { return { m: m, s: score(m, q) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, MAX_ITEMS)
      .map(function (x) { return x.m; });
  }

  function isDark() {
    var bg = getComputedStyle(document.body).backgroundColor || '';
    var m = bg.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] < 128;
  }

  function ensureStyle() {
    if (document.getElementById('aroomo-mention-style')) return;
    var st = document.createElement('style');
    st.id = 'aroomo-mention-style';
    st.textContent =
      '#aroomo-mention{position:fixed;z-index:2147483000;min-width:220px;max-width:min(360px,calc(100vw - 16px));max-height:300px;overflow:auto;' +
      'margin:0;padding:6px;list-style:none;border-radius:12px;font:14px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",system-ui,sans-serif;' +
      'background:#fff;color:#1d1d1f;border:1px solid rgba(0,0,0,.08);box-shadow:0 10px 30px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.06);animation:aroomo-mention-in .14s ease-out}' +
      '#aroomo-mention.dark{background:#1c1c1e;color:#f5f5f7;border-color:rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.5)}' +
      '#aroomo-mention .h{padding:4px 10px 6px;font-size:12px;opacity:.6}' +
      '#aroomo-mention li[role=option]{display:flex;align-items:center;gap:10px;min-height:36px;padding:6px 10px;border-radius:8px;cursor:pointer}' +
      '#aroomo-mention li[role=option] .av{flex:none;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;background:rgba(0,0,0,.06);box-shadow:0 0 0 2px transparent}' +
      '#aroomo-mention.dark li[role=option] .av{background:rgba(255,255,255,.1)}' +
      '#aroomo-mention li[role=option] .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#aroomo-mention li[role=option] .t{flex:none;font-size:12px;opacity:.6}' +
      '#aroomo-mention li[aria-selected=true]{background:#ff7f50;color:#1d1d1f}' +
      '#aroomo-mention li[aria-selected=true] .av{background:rgba(255,255,255,.55)}' +
      '#aroomo-mention li[aria-selected=true] .t{opacity:.75}' +
      '#aroomo-mention .e{padding:8px 10px;opacity:.7}' +
      '#aroomo-mention .e a{color:#b4441b}#aroomo-mention.dark .e a{color:#ff9a73}' +
      '@keyframes aroomo-mention-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
      '@media (prefers-reduced-motion:reduce){#aroomo-mention{animation:none}}' +
      '.aroomo-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}';
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function close() {
    if (box) box.remove();
    box = null;
    if (state && state.el && state.el.removeAttribute) {
      state.el.removeAttribute('aria-activedescendant');
      state.el.removeAttribute('aria-controls');
    }
    state = null;
  }

  function announce(text) {
    if (!live) {
      live = document.createElement('div');
      live.className = 'aroomo-sr';
      live.setAttribute('aria-live', 'polite');
      document.body.appendChild(live);
    }
    live.textContent = text;
  }

  function render(rect) {
    ensureStyle();
    if (!box) {
      box = document.createElement('ul');
      box.id = 'aroomo-mention';
      box.setAttribute('role', 'listbox');
      box.setAttribute('aria-label', '点名成员');
      box.addEventListener('mousedown', function (e) { e.preventDefault(); });
      document.body.appendChild(box);
    }
    box.className = isDark() ? 'dark' : '';
    var items = state.items;
    var html = '<li class="h" role="presentation">点名成员（D31：被 @ 的成员直接回答）</li>';
    if (!items.length) {
      html += '<li class="e" role="presentation">' + (members && members.length ? '没有匹配的成员' : '还没有在职的成员，<a href="/aroomo/members">去成员页</a>') + '</li>';
    }
    items.forEach(function (m, i) {
      var ch = esc((m.name || '?').trim().charAt(0).toUpperCase());
      html += '<li role="option" id="aroomo-mention-' + i + '" aria-selected="' + (i === state.index) + '" data-i="' + i + '">' +
        '<span class="av" aria-hidden="true">' + ch + '</span><span class="n">' + esc(m.name) + '</span>' +
        (m.leadEligible ? '<span class="t">可当负责人</span>' : '') + '</li>';
    });
    box.innerHTML = html;
    var opts = box.querySelectorAll('li[role=option]');
    for (var k = 0; k < opts.length; k++) {
      opts[k].addEventListener('click', function (e) {
        var i = Number(e.currentTarget.getAttribute('data-i'));
        pick(i);
      });
    }
    // 位置：光标上方（放不下就放下方），左右不超出屏幕
    var w = box.offsetWidth, h = box.offsetHeight;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    var top = rect.top - h - 8;
    if (top < 8) top = (rect.bottom || rect.top + 20) + 8;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    if (state.el.setAttribute) {
      state.el.setAttribute('aria-controls', 'aroomo-mention');
      if (items.length) state.el.setAttribute('aria-activedescendant', 'aroomo-mention-' + state.index);
    }
    var sel = box.querySelector('li[aria-selected=true]');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function update(el) {
    var info = caretInfo(el);
    var m = info && AT_RE.exec(info.before);
    if (!m) return close();
    var query = m[2];
    loadMembers().then(function (list) {
      // 异步返回后光标可能已经变了：重新核对
      var again = caretInfo(el);
      var m2 = again && AT_RE.exec(again.before);
      if (!m2 || m2[2] !== query) return;
      var items = filter(list, query);
      var prevName = state && state.items[state.index] && state.items[state.index].name;
      var idx = 0;
      items.forEach(function (it, i) { if (it.name === prevName) idx = i; });
      var wasOpen = Boolean(box);
      state = { el: el, query: query, items: items, index: idx };
      render(again.rect);
      if (!wasOpen) announce(items.length ? items.length + ' 位成员可以点名，用上下键选择，回车填入' : '没有可以点名的成员');
    });
  }

  function insertText(el, text) {
    if (el.tagName === 'TEXTAREA') {
      var end = el.selectionStart;
      var start = end - state.query.length;
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    // 删掉已经输入的筛选词（保留 @），再插入完整名字：都是普通编辑操作，编辑器会同步自己的状态
    for (var i = 0; i < state.query.length; i++) document.execCommand('delete', false);
    document.execCommand('insertText', false, text);
  }

  function pick(i) {
    if (!state || !state.items[i]) return;
    var m = state.items[i];
    var el = state.el;
    // 名字里有 @ 解析器认不出的字符时加引号（解析规则见 core/src/router/mentions.ts）
    var name = /^[\p{L}\p{N}\p{M}_+\-. ]+$/u.test(m.name) && !/[.\s]$/.test(m.name) ? m.name : '"' + m.name.replace(/"/g, '') + '"';
    var text = name + ' ';
    close();
    insertText(el, text);
    announce('已点名 ' + m.name);
  }

  document.addEventListener('input', function (e) {
    if (e.isComposing) return;
    var el = inputRoot(e.target);
    if (!el) return close();
    update(el);
  }, true);
  // 有的编辑器自己处理输入、不一定触发 input 事件：按键抬起时再检查一次
  document.addEventListener('keyup', function (e) {
    if (e.isComposing || /^(Arrow|Enter$|Tab$|Escape$|Shift|Control|Alt|Meta)/.test(e.key)) return;
    var sel = window.getSelection();
    var el = inputRoot((sel && sel.anchorNode) || e.target);
    if (el) update(el);
    else if (state) close();
  }, true);
  document.addEventListener('compositionend', function (e) {
    var el = inputRoot(e.target);
    if (el) update(el);
  }, true);

  // 捕获阶段、在 window 上：比编辑器自己的按键处理先拿到（避免 Enter 直接发送）
  window.addEventListener('keydown', function (e) {
    if (!state || !box || e.isComposing) return;
    var n = state.items.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return close();
    }
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.index = (state.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      var info = caretInfo(state.el);
      render(info ? info.rect : state.el.getBoundingClientRect());
      announce(state.items[state.index].name);
      return;
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(state.index);
    }
  }, true);

  document.addEventListener('selectionchange', function () {
    if (!state) return;
    var info = caretInfo(state.el);
    if (!info || !AT_RE.test(info.before)) close();
  });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', function (e) {
    if (box && !(e.target && e.target.closest && e.target.closest('#aroomo-mention'))) close();
  }, true);

  window.__aroomoMentionDebug = function () { return { open: Boolean(box), state: state && { query: state.query, n: state.items.length } }; };
})();
