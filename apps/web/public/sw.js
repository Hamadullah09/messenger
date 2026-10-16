/* SMA service worker: shows push notifications and opens the right screen on tap.
 * Payloads follow PushPayload in @storeline/shared. Only same-origin paths are opened. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const safeUrl = (url) => (typeof url === 'string' && url.startsWith('/') ? url : '/chats');

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (data.type === 'call-ended') {
    // The call is over: replace the ringing notification, then clear it.
    event.waitUntil(
      self.registration
        .showNotification(data.title || 'Call ended', { tag: data.tag, silent: true })
        .then(() => self.registration.getNotifications({ tag: data.tag }))
        .then((list) => list.forEach((n) => n.close())),
    );
    return;
  }
  if (data.type === 'call') {
    // Someone is calling: rings until answered, declined or the call stops.
    event.waitUntil(
      self.registration.showNotification(data.title || 'SMA call', {
        body: data.body || 'Incoming call',
        tag: data.tag,
        renotify: true,
        requireInteraction: true,
        icon: '/brand/icon-192.png',
        badge: '/brand/icon-192.png',
        vibrate: [800, 400, 800, 400, 800, 400, 800, 400, 800],
        actions: [
          { action: 'answer', title: 'Answer' },
          { action: 'decline', title: 'Decline' },
        ],
        data: {
          url: safeUrl(data.url),
          callId: data.callId,
          userId: data.userId,
          declineToken: data.declineToken,
        },
      }),
    );
    return;
  }
  const emergency = data.type === 'emergency';
  // A meeting starting soon: stays on screen until seen.
  const reminder = data.type === 'reminder';
  event.waitUntil(
    self.registration.showNotification(data.title || 'SMA', {
      body: data.body || 'New message',
      tag: data.tag,
      renotify: emergency || reminder,
      requireInteraction: emergency || reminder,
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-192.png',
      vibrate: emergency ? [300, 150, 300, 150, 300] : reminder ? [200, 100, 200] : undefined,
      data: { url: safeUrl(data.url) },
    }),
  );
});

function open(path) {
  const url = new URL(path, self.location.origin).href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        return client.focus().then((c) => c.navigate(url));
      }
    }
    return self.clients.openWindow(url);
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === 'decline') {
    // One-to-one: decline without opening the app. Group calls simply stop ringing here.
    if (data.callId && data.userId && data.declineToken) {
      event.waitUntil(
        fetch(`/api/v1/public/calls/${encodeURIComponent(data.callId)}/decline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: data.userId, token: data.declineToken }),
        }).catch(() => undefined),
      );
    }
    return;
  }
  const url = safeUrl(data.url);
  event.waitUntil(open(event.action === 'answer' ? `${url}&answer=1` : url));
});
