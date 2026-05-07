// Service Worker for Minhas Economias PWA
const CACHE_NAME = 'minhas-economias-v3';
const urlsToCache = [
  '/MinhasEconomias/',
  '/MinhasEconomias/index.html',
  '/MinhasEconomias/style.css',
  '/MinhasEconomias/app.js',
  '/MinhasEconomias/icon.svg',
  '/MinhasEconomias/manifest.json'
];

// Install event - cache files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache).catch(err => {
        console.log('Cache addAll error:', err);
        // Continue even if some files fail to cache
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip Google APIs and external services
  if (event.request.url.includes('googleapis.com') ||
      event.request.url.includes('google.com') ||
      event.request.url.includes('gsi/client')) {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isAppShell = requestUrl.origin === self.location.origin &&
    requestUrl.pathname.startsWith('/MinhasEconomias/');

  if (isAppShell) {
    // Network-first prevents stale JS/CSS on mobile while keeping offline fallback.
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then(cached => cached || new Response('Offline - unable to load resource'));
        })
    );
    return;
  }

  // Cache-first for other static resources
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;

      return fetch(event.request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      }).catch(() => new Response('Offline - unable to load resource'));
    })
  );
});
