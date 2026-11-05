/*
 * Aroomo 控制台的 Service Worker（X-08 推送提醒）。
 * 只做两件事：收到推送就显示一句话；点通知就打开（或切到）Aroomo 的收件箱。
 * 不缓存页面、不拦截网络请求（没有 fetch 处理）。推送内容只有 { title, url, tag }，正文不放任何内容。
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title.length <= 40 ? data.title : 'Aroomo 有新提醒';
  // 只跳到本站 /console/ 下面，推送里写别的地址一律回收件箱
  const url = typeof data.url === 'string' && data.url.startsWith('/console/') ? data.url : '/console/chat?view=inbox';
  event.waitUntil(
    self.registration.showNotification(title, {
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/console/icon-192.png',
      badge: '/console/icon-192.png',
      lang: 'zh-CN',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/console/chat?view=inbox';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).pathname.startsWith('/console/') && 'focus' in w) {
          await w.focus();
          if ('navigate' in w) await w.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
