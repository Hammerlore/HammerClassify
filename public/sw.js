/* HammerClassify — Service Worker (Caching der App-Shell) */
'use strict';
const CACHE = 'hammerclassify-v4';
const SHELL = [
  '/', '/index.html', '/app.js', '/webauthn.js', '/app.css',
  '/hlsw-base.css', '/design-tokens.css', '/design-fonts.css', '/manifest.webmanifest',
  '/icons/favicon.svg', '/icons/favicon.ico', '/icons/apple-touch-icon.png',
  '/icons/logo-32.png', '/icons/logo-128.png', '/icons/logo-192.png', '/icons/logo-512.png', '/icons/logo-maskable-512.png',
  '/inter-latin-400-normal.woff2', '/inter-latin-500-normal.woff2',
  '/inter-latin-600-normal.woff2', '/inter-latin-700-normal.woff2',
  '/jetbrains-mono-latin-400-normal.woff2', '/jetbrains-mono-latin-500-normal.woff2',
  '/space-grotesk-latin-600-normal.woff2', '/space-grotesk-latin-700-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first für die Shell, API immer live
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
    )
  );
});
