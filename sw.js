const CACHE = 'truewords-review-pwa-server-v39';
const FILES = [
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './nav.css',
  './nav.js',
  './portal.css',
  './truewords-ui-theme.css',
  './truewords-ui-bright.css',
  './truewords-ui-theme.js',
  './truewords-user-theme.js',
  './login.js',
  './account-setup.js',
  './pilot-v2.js',
  './upload.js',
  './review-v30.css',
  './review-v30-app.js',
  './review-v31.css',
  './review-v31-ui.js',
  './vendor/embla-carousel.umd.js',
  './review-v2-app.css',
  './review-v2-app.js',
  './review-v2-events.js',
  './review-navigation-fix.js',
  './review-sidebar-follow.js',
  './review-redesign-v29.css',
  './review-experience-v29.js',
  './review.css',
  './truewords-theme.css',
  './review.js',
  './review-boundaries.css',
  './review-boundaries.js',
  './review-precision.css',
  './review-precision.js',
  './review-cross-owner-fix.js',
  './review-status-colors.css',
  './situation-quiz.css',
  './situation-quiz.js',
  './enhancements.css',
  './enhancements.js',
  './coordination.css',
  './coordination.js',
  './server-sync.css',
  './server-sync.js',
  './doppelpruefung.html',
  './overview.css',
  './seam.css',
  './boundary-pairs.css',
  './boundary-pairs.js',
  './push-settings.html',
  './push-settings.js',
  './push-enable.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/') || request.mode === 'navigate') {
    event.respondWith(fetch(request));
    return;
  }

  // Stale-while-revalidate: aus dem Cache sofort antworten (schnell, offline-
  // tauglich), aber immer parallel im Hintergrund nachladen und den Cache
  // aktualisieren. Reines Cache-first (wie zuvor) servierte CSS/JS nach einem
  // Deploy sonst unbegrenzt lange aus einer alten, nie aktualisierten Kopie —
  // sichtbar erst beim nächsten CACHE-Versionssprung, der leicht vergessen wird.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        }).catch(() => cached);
        return cached || network;
      }),
    ),
  );
});

// --- Web-Push -------------------------------------------------------------
// Cache-Logik oben bleibt unverändert; nur push- und notificationclick-Handler.

self.addEventListener('push', (event) => {
  let data = { title: 'TrueWords', body: 'Neue Benachrichtigung.', url: '/doppelpruefung.html' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (_) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'TrueWords', {
      body: data.body || '',
      icon: './icon.svg',
      badge: './icon.svg',
      tag: data.tag || 'truewords',
      data: { url: data.url || '/doppelpruefung.html' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/doppelpruefung.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
