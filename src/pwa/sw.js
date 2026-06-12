// Outpost service worker. Three responsibilities:
//   1. Standard install/activate (claim clients so the SW takes over without reload)
//   2. Web Push handler with foreground suppression (visible window → in-page message)
//   3. notificationclick handler that deep-links to /?session=<id>&approval=<id>

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed payload — keep defaults */ }
  const { title = 'Outpost', body = '', tag, data: payloadData = {} } = data;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = clients.some((c) => c.visibilityState === 'visible');
    if (hasVisible) {
      // Don't double-notify when the PWA is already on screen — app.js handles the
      // in-app toast via the existing notifications WS. We still forward the payload so
      // future push kinds (non-WS-mirrored) have a delivery path.
      for (const c of clients) {
        c.postMessage({ type: 'push', title, body, data: payloadData });
      }
      return;
    }
    await self.registration.showNotification(title, {
      body,
      tag,
      data: payloadData,
      icon: '/icon-512.png',
      badge: '/icon-512.png',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const sessionId = data.sessionId;
  const approvalId = data.approvalId;
  const url = sessionId
    ? `/?session=${encodeURIComponent(sessionId)}${approvalId ? `&approval=${encodeURIComponent(approvalId)}` : ''}`
    : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If a PWA window is already open, focus it and tell it which deep link to apply —
    // we can't change the URL of an existing tab without a navigation, so postMessage
    // lets the in-page code scroll to the card directly.
    for (const c of clients) {
      if ('focus' in c) {
        c.postMessage({ type: 'deepLink', sessionId, approvalId });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
