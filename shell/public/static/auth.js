/*
 * 登录页 / 设密码页（Shell core-session）。只调用同源 /aroomo/auth/*，令牌只在 HttpOnly Cookie 里，页面脚本拿不到。
 * 不用第三方库。设密码链接里的 token 只从地址栏读，读完就从地址栏抹掉。
 */
(function () {
  'use strict';
  var form = document.getElementById('auth-form');
  var msg = document.getElementById('msg');
  var kind = form.getAttribute('data-kind');
  var params = new URLSearchParams(location.search);
  var next = params.get('next') || '/console/';
  var token = kind === 'accept' ? params.get('token') || '' : '';
  if (token) history.replaceState(null, '', location.pathname);

  function say(t) { msg.textContent = t; }
  function go(n) { location.replace(n); }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-aroomo-request': '1' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    });
  }

  // 已经登录（例如从 Cloudflare Access 跳回来）：直接进控制台
  if (kind === 'login') {
    fetch('/aroomo/auth/session?next=' + encodeURIComponent(next), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (b) { if (b && b.loggedIn && b.owner) go(b.next); })
      .catch(function () { /* 取不到就留在登录页 */ });
  } else if (!token) {
    say('这个链接不完整。请让管理员重新发一个设密码链接。');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    say('');
    var pw = form.password.value;
    var body;
    if (kind === 'login') {
      if (!form.email.value.trim() || !pw) return say('请填写邮箱和密码。');
      body = { email: form.email.value.trim(), password: pw };
    } else {
      if (!token) return say('这个链接不完整。请让管理员重新发一个设密码链接。');
      if (pw.length < 8) return say('密码至少 8 位。');
      if (pw !== form.password2.value) return say('两次输入的密码不一样。');
      body = { token: token, password: pw };
    }
    var btn = form.querySelector('button');
    btn.disabled = true;
    post('/aroomo/auth/' + kind, body)
      .then(function (r) {
        if (r.ok) {
          say('成功，正在打开…');
          return fetch('/aroomo/auth/session?next=' + encodeURIComponent(next), { credentials: 'same-origin' })
            .then(function (s) { return s.json(); })
            .then(function (b) { if (b && b.owner) go(b.next); else say('已登录，但这个账号没有权限使用所有者的控制台。'); });
        }
        var e2 = (r.body && r.body.error) || {};
        say(e2.message || '没有成功，请稍后再试。');
      })
      .catch(function () { say('连不上 Aroomo，请检查网络后再试。'); })
      .then(function () { btn.disabled = false; });
  });
})();
