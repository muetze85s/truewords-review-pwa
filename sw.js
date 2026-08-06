const CACHE = 'truewords-review-pwa-server-v14';
const FILES = [
  './manifest.webmanifest',
  './icon.svg',
  './portal.css',
  './login.js',
  './account-setup.js',
  './pilot-v2.js',
  './upload.js',
  './review.css',
  './truewords-theme.css',
  './review.js',
  './review-boundaries.css',
  './review-boundaries.js',
  './review-precision.css',
  './review-precision.js',
  './enhancements.css',
  './enhancements.js',
  './coordination.css',
  './coordination.js',
  './server-sync.css',
  './server-sync.js',
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

  // Private API responses and authenticated HTML pages must never enter Cache Storage.
  if (url.pathname.startsWith('/api/') || request.mode === 'navigate') {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
