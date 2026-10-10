/* SMA service worker: shows push notifications and opens the right screen on tap.
 * Payloads follow PushPayload in @storeline/shared. Only same-origin paths are opened. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const emergency = data.type === 'emergency';
  event.waitUntil(
    self.registration.showNotification(data.title || 'SMA', {
      body: data.body || 'New message',
      tag: data.tag,
      renotify: emergency,
      requireInteraction: emergency,
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-192.png',
      vibrate: emergency ? [300, 150, 300, 150, 300] : undefined,
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/chats' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/chats', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus().then((c) => c.navigate(url));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
