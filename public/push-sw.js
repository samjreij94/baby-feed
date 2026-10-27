/* Imported by the generated Workbox service worker (see vite.config.ts importScripts).
 * Handles the worker's "Still feeding?" web push (sent with no payload) and notification taps. */
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Still feeding?', {
      body: 'Your breastfeeding timer has been running a while. Tap to keep going or stop & save.',
      tag: 'bf-still-feeding',
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/favicon-32.png',
      data: { url: self.registration.scope + '?timer' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
