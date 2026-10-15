// Service worker: push notifications, with Approve/Deny right on the notification.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const n = event.data ? event.data.json() : { title: 'pouch', body: '', url: '/', tag: 'pouch' };
  event.waitUntil((async () => {
    // Skip the buzz when the app is already open and in front of you.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.focused && c.visibilityState === 'visible')) return;
    await self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/badge.png',
      data: n,
      actions: n.respond
        ? [{ action: 'allow', title: 'Approve' }, { action: 'deny', title: 'Deny' }]
        : [],
      requireInteraction: !!n.respond,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification.data || {};
  event.notification.close();
  event.waitUntil((async () => {
    if (n.respond && (event.action === 'allow' || event.action === 'deny')) {
      const res = await fetch(`/api/sessions/${n.respond.sessionId}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: n.respond.requestId, decision: event.action }),
      }).catch(() => null);
      if (res && res.ok) return;
      // Already answered elsewhere, or offline: fall through and open the session.
    }
    const url = new URL(n.url || '/', self.location.origin).href;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus();
      if (win.url !== url) await win.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
