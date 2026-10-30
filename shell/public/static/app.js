/*
 * Aroomo 页面：成员、Key 与接入、收件箱、收藏、设置（PRODUCT §8.3；D31、D63、D73）。
 * 只调用同源的 /aroomo/api/*（Shell 转发到 Core 并附加主人令牌）。不用任何第三方库。
 * 确认一律用本文件的确认卡（docs/architecture/CONFIRM-CARD.md），不用浏览器 confirm()。
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var PAGES = { favorites: '收藏', members: '成员', inbox: '收件箱', settings: '设置' };
  var SETTINGS_TABS = [['general', '通用'], ['lead', '负责人'], ['account', '账号'], ['notify', '通知'], ['security', '安全'], ['advanced', '高级']];
  var TAG_LABELS = { text: '文字', 'long-context': '长文', image: '图像', video: '视频', multimodal: '多模态', voice: '语音', code: '代码', reasoning: '推理' };
  var ICON = {
    favorites: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    members: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.8c1.9.6 3.2 2.3 3.5 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  };
  var state = { unread: 0 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------------- 接口 ---------------- */
  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { accept: 'application/json', 'x-aroomo-request': '1' } };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('/aroomo/api' + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (r.status === 401 && data && data.error && data.error.code === 'LOGIN_REQUIRED') {
          location.href = '/signin?callbackUrl=' + encodeURIComponent(location.pathname);
        }
        return { status: r.status, ok: r.ok, data: data };
      });
    });
  }
  function errMsg(res) {
    return (res && res.data && res.data.error && res.data.error.message) || '出了点问题，请稍后再试';
  }

  /* ---------------- 提示（可撤销） ---------------- */
  var toastTimer = null;
  function toast(text, undo) {
    var old = $('.toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + esc(text) + '</span>' + (undo ? '<button type="button">撤销</button>' : '');
    document.body.appendChild(el);
    if (undo) $('button', el).onclick = function () { el.remove(); undo(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, undo ? 8000 : 3000);
  }

  /* ---------------- 确认卡（CONFIRM-CARD.md） ----------------
   * send(confirmToken?) 发原请求，返回 api() 的结果。普通操作直接成功；428 时渲染重要确认卡：
   * 后果全部展开 → 按钮①「继续」→ 按钮②（confirmLabel，3 秒倒计时，以服务端时间为准）→ 拿到令牌自动重发。 */
  function withConfirm(send) {
    return send().then(function (res) {
      if (res.status !== 428 || !res.data || !res.data.error || !res.data.error.confirm) return res;
      return runChallenge(res.data.error.confirm, send);
    });
  }
  function stepUrl(ch) { return String(ch.stepUrl).replace(/^\/api\//, '/'); }
  function runChallenge(ch, send) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'confirm-backdrop';
      back.innerHTML =
        '<div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-title">' +
        '<h3 id="cf-title">' + esc(ch.title) + '</h3>' +
        '<ul>' + (ch.consequences || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' +
        (ch.requiresAccessReauth ? '<p class="reauth" hidden>请先重新验证身份：<a href="/cdn-cgi/access/login" target="_blank" rel="noopener">打开验证</a>，完成后回到这里再点一次。</p>' : '') +
        '<div class="steps"><button type="button" class="btn" data-cancel>取消</button>' +
        '<span><button type="button" class="btn" data-step1>继续</button> <button type="button" class="btn danger" data-step2 hidden disabled></button></span></div>' +
        '<p class="err" role="alert" hidden></p></div>';
      document.body.appendChild(back);
      var b1 = $('[data-step1]', back), b2 = $('[data-step2]', back), err = $('.err', back), reauth = $('.reauth', back);
      var label = ch.confirmLabel || '确认';
      var timer = null;
      function close(result) { clearInterval(timer); back.remove(); resolve(result); }
      function showErr(t) { err.textContent = t; err.hidden = false; }
      function countdown(notBefore) {
        var serverOffset = 0;
        var target = notBefore ? new Date(notBefore).getTime() - serverOffset : Date.now() + (ch.minDelayMs || 3000);
        b2.hidden = false;
        b2.disabled = true;
        clearInterval(timer);
        function tick() {
          var left = Math.ceil((target - Date.now()) / 1000);
          if (left > 0) {
            b2.textContent = label + '（' + left + '）';
            b2.setAttribute('aria-label', label + '，还要等 ' + left + ' 秒');
          } else {
            clearInterval(timer);
            b2.textContent = label;
            b2.removeAttribute('aria-label');
            b2.disabled = false;
          }
        }
        tick();
        timer = setInterval(tick, 250);
      }
      $('[data-cancel]', back).onclick = function () { close({ status: 0, ok: false, cancelled: true }); };
      back.addEventListener('keydown', function (e) { if (e.key === 'Escape') close({ status: 0, ok: false, cancelled: true }); });
      b1.focus();
      b1.onclick = function () {
        b1.disabled = true;
        api('POST', stepUrl(ch), { step: 1 }).then(function (r) {
          if (!r.ok) {
            b1.disabled = false;
            return showErr(errMsg(r));
          }
          b1.hidden = true;
          if (reauth) reauth.hidden = false;
          countdown(r.data.confirm && r.data.confirm.step2NotBefore);
        });
      };
      b2.onclick = function () {
        b2.disabled = true;
        api('POST', stepUrl(ch), { step: 2 }).then(function (r) {
          if (r.ok && r.data && r.data.confirmToken) {
            var token = r.data.confirmToken;
            r.data.confirmToken = null;
            send(token).then(close);
            return;
          }
          var code = r.data && r.data.error && r.data.error.code;
          if (code === 'CONFIRM_TOO_EARLY') {
            countdown(new Date(Date.now() + (r.data.error.retryAfterMs || 1000)).toISOString());
          } else if (code === 'ACCESS_REAUTH_REQUIRED') {
            if (reauth) reauth.hidden = false;
            b2.disabled = false;
            showErr('请先重新验证身份，然后再点一次。');
          } else if (code === 'CONFIRM_STEP1_REQUIRED') {
            b1.hidden = false;
            b1.disabled = false;
            b2.hidden = true;
          } else {
            showErr(errMsg(r) + '（请重新操作）');
            setTimeout(function () { close(r); }, 1500);
          }
        });
      };
    });
  }

  /* ---------------- 布局 ---------------- */
  function route() {
    var parts = location.pathname.replace(/^\/aroomo\/?/, '').split('/').filter(Boolean);
    return { page: PAGES[parts[0]] ? parts[0] : 'members', sub: parts[1] || '' };
  }
  function empty(text, btn) {
    return '<div class="empty"><img src="/aroomo/static/logo.svg" alt="" width="40" height="40"><div>' + esc(text) + '</div>' + (btn || '<a class="btn" href="/">回到对话</a>') + '</div>';
  }
  function shellHtml(r, title, body) {
    var nav = Object.keys(PAGES).map(function (k) {
      return '<a href="/aroomo/' + k + '"' + (k === r.page ? ' aria-current="page"' : '') + '>' + ICON[k] + '<span>' + PAGES[k] + '</span>' + (k === 'inbox' && state.unread ? '<span class="dot" aria-label="' + state.unread + ' 条未读"></span>' : '') + '</a>';
    }).join('');
    var mbar = Object.keys(PAGES).map(function (k) {
      return '<a href="/aroomo/' + k + '" aria-label="' + PAGES[k] + '"' + (k === r.page ? ' aria-current="page"' : '') + '>' + ICON[k] + (k === 'inbox' && state.unread ? '<span class="dot"></span>' : '') + '</a>';
    }).join('');
    return '<div class="mtop"><a href="/" aria-label="回到对话">' + ICON.chat + '</a><strong>' + esc(title) + '</strong></div>' +
      '<div class="layout"><aside class="side"><a class="brand" href="/"><img src="/aroomo/static/logo.svg" alt="">Aroomo</a>' +
      '<nav class="nav" aria-label="Aroomo"><a href="/">' + ICON.chat + '<span>对话</span></a>' + nav + '</nav></aside>' +
      '<main class="main" id="main">' + body + '</main></div><nav class="mbar" aria-label="Aroomo">' + mbar + '</nav>';
  }
  function render() {
    var r = route();
    var title = PAGES[r.page];
    document.title = title + ' · Aroomo';
    app.innerHTML = shellHtml(r, title, '<h1>' + esc(title) + '</h1><div id="page"><p class="muted">加载中…</p></div>');
    var page = $('#page');
    ({ members: pageMembers, inbox: pageInbox, favorites: pageFavorites, settings: pageSettings })[r.page](page, r);
  }
  function refreshUnread() {
    return api('GET', '/inbox/unread-count').then(function (res) {
      if (res.ok && res.data) state.unread = res.data.total || 0;
    });
  }

  /* ---------------- 成员 + Key 与接入（§8.3） ---------------- */
  function pageMembers(page, r) {
    var tab = r.sub === 'keys' ? 'keys' : 'members';
    page.innerHTML = '<div class="tabs" role="tablist"><a role="tab" href="/aroomo/members" aria-selected="' + (tab === 'members') + '">成员</a><a role="tab" href="/aroomo/members/keys" aria-selected="' + (tab === 'keys') + '">Key 与接入</a></div><div id="tab"></div>';
    if (tab === 'keys') keysTab($('#tab', page));
    else membersTab($('#tab', page));
  }

  function avatar(m) {
    var ch = (m.name || '?').trim().charAt(0).toUpperCase();
    var style = m.enabled ? '' : 'filter:grayscale(1);opacity:.6';
    return '<span aria-hidden="true" style="flex:none;width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--bg),0 0 0 4px ' + (m.enabled ? 'var(--accent)' : 'var(--line)') + ';background:var(--bg-2);font-weight:600;' + style + '">' + esc(ch) + '</span>';
  }

  /* 模型事实（后端从模型网关判定，§9.1）：上下文、工具调用、可当负责人 */
  function capsTags(m) {
    var c = m.modelCaps;
    var out = '';
    if (c && c.maxInputTokens) out += '<span class="tag">上下文 ' + Math.round(c.maxInputTokens / 1000) + 'k</span>';
    if (c && c.supportsTools) out += '<span class="tag">工具调用</span>';
    if (c && c.mode && c.mode !== 'chat' && c.mode !== 'responses') out += '<span class="tag">专用模型</span>';
    if (!c) out += '<span class="tag">能力未知</span>';
    if (m.leadEligible || (c && c.mode && /^(chat|responses)$/.test(c.mode) && c.maxInputTokens >= 32000 && c.supportsTools)) out += '<span class="tag">可当负责人</span>';
    return out;
  }

  function membersTab(el) {
    Promise.all([api('GET', '/members'), api('GET', '/members?deleted=true'), api('GET', '/settings/lead')]).then(function (rs) {
      var all = (rs[0].data && rs[0].data.members) || [];
      var list = all.filter(function (m) { return m.status !== 'candidate'; });
      var cands = all.filter(function (m) { return m.status === 'candidate'; });
      var bin = (rs[1].data && rs[1].data.members) || [];
      var lead = rs[2].data || {};
      if (!rs[0].ok) { el.innerHTML = '<p class="status-bad">' + esc(errMsg(rs[0])) + '</p>'; return; }
      var html = '<form class="addbar" id="add-member"><input name="name" required maxlength="200" placeholder="成员英文原名，例如 Gemini 2.5 Pro" aria-label="成员名字"><button class="btn primary">添加</button></form>';
      if (cands.length) {
        // §8.3「候选（N）」、§9.1 入职流程：加 Key 自动发现的模型先在这里，一键入职
        html += '<h2 id="candidates">候选（' + cands.length + '）</h2><div id="clist">';
        cands.forEach(function (m) {
          html += '<div class="row" data-id="' + esc(m.id) + '">' + avatar(m) +
            '<span class="grow"><span class="name">' + esc(m.name) + '</span>' + capsTags(m) + '</span>' +
            '<button class="btn primary" data-onboard>入职</button><button class="btn" data-reject>不要</button></div>';
        });
        html += '</div>';
      }
      if (!list.length) {
        html += cands.length ? '' : empty('还没有成员。在「Key 与接入」里填入一个 Key，它的模型会进入候选，点「入职」就能在对话里用。', '<a class="btn primary" href="/aroomo/members/keys">去填 Key</a>');
      } else {
        if (cands.length) html += '<h2>在职（' + list.length + '）</h2>';
        html += '<div class="addbar" style="justify-content:space-between"><span class="muted">拖动排序；选中后可批量删除</span><button class="btn danger" id="batch-del" disabled>删除选中</button></div><div id="mlist">';
        list.forEach(function (m) {
          var isLead = lead.effectiveLeadId === m.id;
          html += '<div class="row" draggable="true" data-id="' + esc(m.id) + '">' +
            '<input type="checkbox" aria-label="选中 ' + esc(m.name) + '" data-sel>' + avatar(m) +
            '<span class="grow"><span class="name">' + esc(m.name) + '</span>' +
            (isLead ? '<span class="tag">负责人</span>' : '') + (m.pinned ? '<span class="tag">置顶</span>' : '') +
            m.capabilityTags.map(function (t) { return '<span class="tag">' + esc(TAG_LABELS[t] || t) + '</span>'; }).join('') + '</span>' +
            '<button class="icon-btn" data-up aria-label="上移">↑</button><button class="icon-btn" data-down aria-label="下移">↓</button>' +
            '<button class="btn" data-toggle>' + (m.enabled ? '停用' : '启用') + '</button>' +
            '<button class="btn" data-pin>' + (m.pinned ? '取消置顶' : '置顶') + '</button>' +
            '<button class="btn danger" data-del>删除</button></div>';
        });
        html += '</div>';
      }
      if (bin.length) {
        html += '<h2>回收站（30 天后自动彻底删除）</h2>';
        bin.forEach(function (m) {
          html += '<div class="row" data-id="' + esc(m.id) + '">' + avatar(m) + '<span class="grow">' + esc(m.name) + '</span><button class="btn" data-restore>恢复</button><button class="btn danger" data-purge>彻底删除</button></div>';
        });
      }
      el.innerHTML = html;
      $('#add-member', el).onsubmit = function (e) {
        e.preventDefault();
        var name = e.target.name.value.trim();
        if (!name) return;
        api('POST', '/members', { name: name }).then(function (res) {
          if (!res.ok) return toast(errMsg(res));
          toast('已添加「' + name + '」');
          membersTab(el);
        });
      };
      var ids = list.map(function (m) { return m.id; });
      var candIds = cands.map(function (m) { return m.id; });
      function saveOrder(next) {
        // 排序接口要求包含全部未删除成员：候选排在后面
        api('PUT', '/members/order', { ids: next.concat(candIds) }).then(function (res) {
          if (!res.ok) toast(errMsg(res));
          membersTab(el);
        });
      }
      $all('#mlist .row', el).forEach(function (row) {
        var id = row.getAttribute('data-id');
        var m = list.filter(function (x) { return x.id === id; })[0];
        var i = ids.indexOf(id);
        $('[data-up]', row).onclick = function () { if (i > 0) { var n = ids.slice(); n.splice(i, 1); n.splice(i - 1, 0, id); saveOrder(n); } };
        $('[data-down]', row).onclick = function () { if (i < ids.length - 1) { var n = ids.slice(); n.splice(i, 1); n.splice(i + 1, 0, id); saveOrder(n); } };
        $('[data-toggle]', row).onclick = function () {
          api('PATCH', '/members/' + encodeURIComponent(id), { enabled: !m.enabled }).then(function (res) { if (!res.ok) toast(errMsg(res)); membersTab(el); });
        };
        $('[data-pin]', row).onclick = function () {
          api(m.pinned ? 'DELETE' : 'PUT', '/members/' + encodeURIComponent(id) + '/pin').then(function (res) { if (!res.ok) toast(errMsg(res)); membersTab(el); });
        };
        $('[data-del]', row).onclick = function () {
          api('DELETE', '/members/' + encodeURIComponent(id)).then(function (res) {
            if (!res.ok) return toast(errMsg(res));
            membersTab(el);
            toast('已移到回收站：' + m.name, function () {
              api('POST', '/members/' + encodeURIComponent(id) + '/restore').then(function () { membersTab(el); });
            });
          });
        };
        $('[data-sel]', row).onchange = function () {
          $('#batch-del', el).disabled = !$all('[data-sel]:checked', el).length;
        };
        row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', id); });
        row.addEventListener('dragover', function (e) { e.preventDefault(); });
        row.addEventListener('drop', function (e) {
          e.preventDefault();
          var from = e.dataTransfer.getData('text/plain');
          if (!from || from === id) return;
          var n = ids.filter(function (x) { return x !== from; });
          n.splice(n.indexOf(id), 0, from);
          saveOrder(n);
        });
      });
      var batch = $('#batch-del', el);
      if (batch) batch.onclick = function () {
        var sel = $all('[data-sel]:checked', el).map(function (c) { return c.closest('.row').getAttribute('data-id'); });
        Promise.all(sel.map(function (id) { return api('DELETE', '/members/' + encodeURIComponent(id)); })).then(function () {
          membersTab(el);
          toast('已移到回收站：' + sel.length + ' 个成员', function () {
            Promise.all(sel.map(function (id) { return api('POST', '/members/' + encodeURIComponent(id) + '/restore'); })).then(function () { membersTab(el); });
          });
        });
      };
      $all('#clist .row', el).forEach(function (row) {
        var id = row.getAttribute('data-id');
        var m = cands.filter(function (x) { return x.id === id; })[0];
        $('[data-onboard]', row).onclick = function () {
          api('POST', '/members/' + encodeURIComponent(id) + '/onboard').then(function (res) {
            if (!res.ok) return toast(errMsg(res));
            toast('「' + m.name + '」已入职，可以在对话里 @ 它了');
            refreshUnread().then(function () { membersTab(el); });
          });
        };
        $('[data-reject]', row).onclick = function () {
          api('DELETE', '/members/' + encodeURIComponent(id)).then(function (res) {
            if (!res.ok) return toast(errMsg(res));
            membersTab(el);
            toast('已移到回收站：' + m.name, function () {
              api('POST', '/members/' + encodeURIComponent(id) + '/restore').then(function () { membersTab(el); });
            });
          });
        };
      });
      $all('[data-restore]', el).forEach(function (b) {
        b.onclick = function () {
          var id = b.closest('.row').getAttribute('data-id');
          api('POST', '/members/' + encodeURIComponent(id) + '/restore').then(function (res) { if (!res.ok) toast(errMsg(res)); membersTab(el); });
        };
      });
      $all('[data-purge]', el).forEach(function (b) {
        b.onclick = function () {
          var id = b.closest('.row').getAttribute('data-id');
          withConfirm(function (token) {
            return api('POST', '/members/' + encodeURIComponent(id) + '/purge', token ? { confirmToken: token } : undefined);
          }).then(function (res) {
            if (res.cancelled) return;
            if (!res.ok) toast(errMsg(res));
            else toast('已彻底删除');
            membersTab(el);
          });
        };
      });
    });
  }

  function keysTab(el) {
    api('GET', '/keys').then(function (res) {
      if (!res.ok) { el.innerHTML = '<p class="status-bad">' + esc(errMsg(res)) + '</p>'; return; }
      var keys = res.data.keys || [];
      var html =
        '<form class="addbar" id="add-key" autocomplete="off">' +
        '<input name="sourceUrl" type="url" required placeholder="获取网址（在哪里申请的）" aria-label="获取网址">' +
        '<input name="name" required maxlength="64" placeholder="名称，例如 OpenAI 主号" aria-label="名称">' +
        '<input name="model" required placeholder="服务商/模型，例如 groq/openai/gpt-oss-20b" aria-label="模型" pattern="[A-Za-z0-9._:/@+\\-]+">' +
        '<input name="apiKey" type="password" required minlength="12" placeholder="Key" aria-label="Key" autocomplete="new-password">' +
        '<button class="btn primary">保存</button>' +
        '<details style="flex-basis:100%"><summary class="muted">高级</summary><div class="addbar" style="margin:8px 0 0;padding:0">' +
        '<input name="modelName" maxlength="128" placeholder="成员名字（默认 = 模型）" aria-label="成员名字">' +
        '<input name="apiBase" type="url" placeholder="接口地址（默认服务商地址）" aria-label="接口地址"></div></details></form>';
      if (!keys.length) html += empty('还没有 Key。填一个 Key，保存后它的模型会进入「成员 → 候选」，点「入职」就能在对话里用了。', ' ');
      keys.forEach(function (k) {
        html += '<div class="row" data-id="' + esc(k.id) + '"><span class="grow"><span class="name">' + esc(k.name) + '</span><span class="tag">…' + esc(k.last4) + '</span>' +
          (k.status === 'active' ? '<span class="tag status-ok">可用</span>' : '<span class="tag status-bad">模型列表同步失败</span>') + '</span>' +
          '<a class="icon-btn" href="' + esc(k.sourceUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="打开获取网址">↗</a>' +
          '<button class="btn" data-rename>改名</button><button class="btn" data-replace>换 Key</button><button class="btn danger" data-del>删除</button></div>';
      });
      el.innerHTML = html;
      $('#add-key', el).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        var body = { name: f.name.value.trim(), sourceUrl: f.sourceUrl.value.trim(), model: f.model.value.trim(), apiKey: f.apiKey.value.trim() };
        if (f.modelName.value.trim()) body.modelName = f.modelName.value.trim();
        if (f.apiBase.value.trim()) body.apiBase = f.apiBase.value.trim();
        var btn = $('button.primary', f);
        btn.disabled = true;
        // D73：主人手动保存是普通保存；若服务端要求重要确认，走确认卡
        withConfirm(function (token) {
          var b = Object.assign({}, body);
          if (token) b.confirmToken = token;
          return api('POST', '/keys', b);
        }).then(function (r) {
          btn.disabled = false;
          f.apiKey.value = '';
          body.apiKey = '';
          if (r.cancelled) return;
          if (!r.ok) return toast(errMsg(r));
          toast('已保存（末 4 位 ' + r.data.key.last4 + '）。模型已进入候选，去「成员」点「入职」');
          refreshUnread();
          keysTab(el);
        });
      };
      $all('.row', el).forEach(function (row) {
        var id = row.getAttribute('data-id');
        var k = keys.filter(function (x) { return x.id === id; })[0];
        $('[data-rename]', row).onclick = function () {
          inlineEdit(row, '新名称', k.name, 'text', function (v) {
            return api('PATCH', '/keys/' + id, { name: v }).then(function (r) { if (!r.ok) toast(errMsg(r)); keysTab(el); });
          });
        };
        $('[data-replace]', row).onclick = function () {
          inlineEdit(row, '新的 Key（整条替换）', '', 'password', function (v) {
            return withConfirm(function (token) {
              var b = { apiKey: v };
              if (token) b.confirmToken = token;
              return api('PATCH', '/keys/' + id, b);
            }).then(function (r) {
              v = '';
              if (r.cancelled) return keysTab(el);
              if (!r.ok) toast(errMsg(r));
              else toast('已换成末 4 位 ' + r.data.key.last4);
              keysTab(el);
            });
          });
        };
        $('[data-del]', row).onclick = function () {
          withConfirm(function (token) {
            return api('DELETE', '/keys/' + id, token ? { confirmToken: token } : undefined);
          }).then(function (r) {
            if (r.cancelled) return;
            if (!r.ok) toast(errMsg(r));
            else toast('已删除');
            keysTab(el);
          });
        };
      });
    });
  }

  function inlineEdit(row, label, value, type, onSave) {
    var form = document.createElement('form');
    form.className = 'row';
    form.innerHTML = '<input class="grow" type="' + type + '" aria-label="' + esc(label) + '" placeholder="' + esc(label) + '" value="' + esc(value) + '" autocomplete="' + (type === 'password' ? 'new-password' : 'off') + '" required><button class="btn primary">保存</button><button type="button" class="btn" data-cancel>取消</button>';
    row.replaceWith(form);
    var input = $('input', form);
    input.focus();
    $('[data-cancel]', form).onclick = function () { form.replaceWith(row); };
    form.onsubmit = function (e) {
      e.preventDefault();
      var v = input.value.trim();
      input.value = '';
      if (v) onSave(v);
    };
  }

  /* ---------------- 收件箱（三组，§8.3、§9.9） ---------------- */
  var GROUPS = [['decision', '待你拍板或接管'], ['candidate', '候选'], ['brief', '每日简报']];
  function pageInbox(page) {
    api('GET', '/inbox?status=open').then(function (res) {
      if (!res.ok) { page.innerHTML = '<p class="status-bad">' + esc(errMsg(res)) + '</p>'; return; }
      var groups = res.data.groups || {};
      var total = GROUPS.reduce(function (n, g) { return n + (groups[g[0]] || []).length; }, 0);
      if (!total) { page.innerHTML = empty('收件箱是空的，没有需要你处理的事。'); return; }
      var html = '';
      GROUPS.forEach(function (g) {
        var items = groups[g[0]] || [];
        if (!items.length) return;
        html += '<h2>' + g[1] + '（' + items.length + '）</h2>';
        items.forEach(function (it) {
          html += '<div class="card" data-id="' + esc(it.id) + '"><div class="title">' + (it.urgency === 'urgent' ? '<span class="tag status-bad">紧急</span> ' : '') + esc(it.title) + '</div>' +
            (it.summary ? '<div class="muted">' + esc(it.summary) + '</div>' : '') +
            '<div class="actions">' + (it.actions || []).map(function (a) {
              var important = (a.confirm && a.confirm.kind !== 'normal') || a.irreversible;
              return '<button class="btn' + (important ? ' danger' : '') + '" data-action="' + esc(a.id) + '">' + esc(a.label) + '</button>';
            }).join('') + '<button class="btn" data-dismiss>稍后</button></div></div>';
        });
      });
      page.innerHTML = html;
      $all('.card', page).forEach(function (card) {
        var id = card.getAttribute('data-id');
        function disable() { $all('button', card).forEach(function (b) { b.disabled = true; }); }
        $all('[data-action]', card).forEach(function (b) {
          b.onclick = function () {
            disable();
            withConfirm(function (token) {
              return api('POST', '/inbox/' + id + '/actions/' + encodeURIComponent(b.getAttribute('data-action')), token ? { confirmToken: token } : {});
            }).then(function (r) {
              if (r.cancelled) return pageInbox(page);
              if (!r.ok) toast(errMsg(r));
              card.classList.add('done');
              refreshUnread().then(render);
            });
          };
        });
        $('[data-dismiss]', card).onclick = function () {
          disable();
          api('POST', '/inbox/' + id + '/dismiss').then(function () { refreshUnread().then(render); });
        };
      });
    });
  }

  /* ---------------- 收藏（P0 不在范围，PRODUCT 16.1） ---------------- */
  function pageFavorites(page) {
    page.innerHTML = empty('收藏会在下一期开放。');
  }

  /* ---------------- 设置（左侧 6 个 Tab，每项「标签 + 控件」，说明放 ⓘ） ---------------- */
  function info(text) { return ' <span title="' + esc(text) + '" aria-label="' + esc(text) + '" tabindex="0" class="muted">ⓘ</span>'; }
  function field(label, control, tip) { return '<div class="field"><label>' + esc(label) + (tip ? info(tip) : '') + '</label><div class="grow">' + control + '</div></div>'; }
  function pageSettings(page, r) {
    var tab = SETTINGS_TABS.some(function (t) { return t[0] === r.sub; }) ? r.sub : 'general';
    page.innerHTML = '<div class="settings"><nav class="vtabs" aria-label="设置">' + SETTINGS_TABS.map(function (t) {
      return '<a href="/aroomo/settings/' + t[0] + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '>' + t[1] + '</a>';
    }).join('') + '</nav><section class="panel" id="panel"></section></div>';
    var panel = $('#panel', page);
    if (tab === 'general') {
      panel.innerHTML = field('语言', '简体中文') + field('外观', '跟随系统', '深色 / 浅色跟随电脑或手机的设置') + field('Key 与接入', '<a class="btn" href="/aroomo/members/keys">管理 Key</a>');
    } else if (tab === 'lead') {
      Promise.all([api('GET', '/members'), api('GET', '/settings/lead')]).then(function (rs) {
        var all = ((rs[0].data && rs[0].data.members) || []).filter(function (m) { return m.enabled && m.status !== 'candidate'; });
        var members = all.filter(function (m) { return m.leadEligible; });
        var others = all.filter(function (m) { return !m.leadEligible; });
        var lead = rs[1].data || {};
        var rule = '负责人要能文字对话、上下文 ≥32k、支持工具调用（由后台判定，§9.1）';
        if (!all.length) { panel.innerHTML = empty('还没有在职的成员。先填入一个 Key，再到「成员」点「入职」。', '<a class="btn primary" href="/aroomo/members/keys">去填 Key</a>'); return; }
        var why = others.length ? '<h2>不能当负责人</h2>' + others.map(function (m) {
          return '<div class="row"><span class="grow">' + esc(m.name) + '</span><span class="muted">' + esc(m.leadIneligibleReason || '') + '</span></div>';
        }).join('') : '';
        if (!members.length) {
          panel.innerHTML = field('负责人', '还没有合格的成员', rule) + '<p class="muted">没有负责人时，不 @ 的消息不会有人接；可以用「@成员名」直接点名。</p>' + why;
          return;
        }
        var opts = '<option value="">自动（第一个合格的成员）</option>' + members.map(function (m) {
          return '<option value="' + esc(m.id) + '"' + (lead.leadId === m.id && !lead.auto ? ' selected' : '') + '>' + esc(m.name) + '</option>';
        }).join('');
        var eff = members.filter(function (m) { return m.id === lead.effectiveLeadId; })[0];
        panel.innerHTML = field('负责人', '<select id="lead" aria-label="负责人">' + opts + '</select>', '对话里没有 @ 成员时，交给负责人回答（D31）。' + rule) +
          field('当前生效', esc(eff ? eff.name : '—') + (lead.auto ? '（自动）' : '')) + why;
        $('#lead', panel).onchange = function (e) {
          api('PUT', '/settings/lead', { leadId: e.target.value || null }).then(function (res) {
            if (!res.ok) toast(errMsg(res));
            else toast('已保存');
            pageSettings(page, r);
          });
        };
      });
    } else if (tab === 'account') {
      panel.innerHTML = field('登录', '<button class="btn" id="logout">退出登录</button>', '退出后需要重新验证邮箱才能再进来') +
        '<p class="muted">网站账号管理会在下一期开放。</p>';
      $('#logout', panel).onclick = function (e) {
        var b = e.currentTarget;
        b.disabled = true;
        fetch('/aroomo/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-aroomo-request': '1', accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (j) { location.href = (j && j.location) || '/signin'; })
          .catch(function () { b.disabled = false; toast('退出失败，请稍后再试'); });
      };
    } else if (tab === 'notify') {
      panel.innerHTML = empty('通知设置会在下一期开放；现在所有提醒都进收件箱。', '<a class="btn" href="/aroomo/inbox">打开收件箱</a>');
    } else if (tab === 'security') {
      Promise.all([api('GET', '/audit?limit=20'), api('GET', '/settings/security')]).then(function (rs) {
        var res = rs[0];
        var sec = (rs[1].ok && rs[1].data) || { sensitiveProtect: true };
        var rows = (res.ok && res.data && res.data.entries) || [];
        panel.innerHTML = field('登录', '只允许你的邮箱登录', '服务器版还要先通过 Cloudflare Access 验证') +
          field('敏感内容保护', '<label class="switch"><input type="checkbox" role="switch" id="sens"' + (sec.sensitiveProtect ? ' checked' : '') + ' aria-label="敏感内容保护"><span aria-hidden="true"></span></label>',
            '开着时，含密码、银行卡号、Key 等敏感信息的消息不发给外部成员（D38，默认开）') +
          '<h2>最近操作记录</h2>' + (rows.length ? rows.map(function (e) {
            return '<div class="row"><span class="muted" style="width:150px;flex:none">' + esc(new Date(e.ts).toLocaleString('zh-CN', { hour12: false })) + '</span><span class="grow">' + esc(e.action) + ' · ' + esc(e.target && e.target.type) + '</span><span class="' + (e.result === 'ok' ? 'status-ok' : 'status-bad') + '">' + esc(e.result) + '</span></div>';
          }).join('') : '<p class="muted">还没有记录</p>');
        $('#sens', panel).onchange = function (e) {
          var on = e.target.checked;
          api('PUT', '/settings/security', { sensitiveProtect: on }).then(function (r2) {
            if (!r2.ok) { e.target.checked = !on; return toast(errMsg(r2)); }
            toast(on ? '已开启敏感内容保护' : '已关闭敏感内容保护');
          });
        };
      });
    } else {
      panel.innerHTML = field('Key 与接入', '<a class="btn" href="/aroomo/members/keys">管理 Key</a>', 'Key 只保存在模型网关里，页面上只显示末 4 位') +
        field('关于', 'Aroomo 本地版 / 服务器版', '对话界面基于开源项目 LobeHub（LobeHub Community License），仅供自用');
    }
  }

  refreshUnread().then(render, render);
  window.addEventListener('popstate', render);
})();
