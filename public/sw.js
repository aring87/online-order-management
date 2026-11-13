'use strict';
// Service worker: makes the app installable and lets the app shell open instantly / offline.
// Data (/api/*) is never cached — orders and customer info always come live from the server.
const CACHE = 'butcher-v1';
const SHELL = [
  '/', '/admin', '/styles.css', '/order.js', '/app.js',
  '/manifest.webmanifest', '/admin.webmanifest',
  '/icons/icon-192.png', '/icons/admin-icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Network first so updates show up right away; fall back to the cached copy when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
