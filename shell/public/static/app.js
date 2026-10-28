/* Aroomo 页面骨架（第一版：页面结构与空状态；接 Core API 在下一个 PR） */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var PAGES = { favorites: '收藏', members: '成员', inbox: '收件箱', settings: '设置' };
  var SETTINGS_TABS = [
    ['general', '通用'], ['lead', '负责人'], ['account', '账号'], ['notify', '通知'], ['security', '安全'], ['advanced', '高级'],
  ];
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function route() {
    var parts = location.pathname.replace(/^\/aroomo\/?/, '').split('/').filter(Boolean);
    return { page: PAGES[parts[0]] ? parts[0] : 'members', sub: parts[1] || '' };
  }
  function empty(text) { return '<div class="empty"><img src="/aroomo/static/logo.svg" alt="" width="40" height="40"><div>' + esc(text) + '</div><a class="btn" href="/">回到对话</a></div>'; }
  function render() {
    var r = route();
    document.title = PAGES[r.page] + ' · Aroomo';
    var nav = Object.keys(PAGES).map(function (k) {
      return '<a href="/aroomo/' + k + '"' + (k === r.page ? ' aria-current="page"' : '') + '>' + PAGES[k] + '</a>';
    }).join('');
    var body = '<h1>' + PAGES[r.page] + '</h1>';
    if (r.page === 'settings') {
      var tab = SETTINGS_TABS.some(function (t) { return t[0] === r.sub; }) ? r.sub : 'general';
      body += '<div class="settings"><nav class="vtabs" aria-label="设置">' + SETTINGS_TABS.map(function (t) {
        return '<a href="/aroomo/settings/' + t[0] + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '>' + t[1] + '</a>';
      }).join('') + '</nav><section class="panel">' + empty('即将开放') + '</section></div>';
    } else body += empty('即将开放');
    app.innerHTML = '<div class="mtop"><a href="/" aria-label="回到对话">‹</a><strong>' + PAGES[r.page] + '</strong></div><div class="layout"><aside class="side"><a class="brand" href="/"><img src="/aroomo/static/logo.svg" alt="">Aroomo</a><nav class="nav" aria-label="Aroomo">' + nav + '</nav></aside><main class="main">' + body + '</main></div>';
  }
  render();
})();
