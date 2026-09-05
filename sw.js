const CACHE = 'workout-tracker-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

// ============================================================
// INSTALL
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(SHELL_ASSETS).catch(err => {
        console.warn('Failed to pre-cache some assets:', err);
        // Continue even if pre-cache partially fails
      });
    }).then(() => self.skipWaiting())
  );
});

// ============================================================
// ACTIVATE
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(cacheName => cacheName !== CACHE)
          .map(cacheName => caches.delete(cacheName))
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================
// FETCH
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Only same-origin requests
  if (new URL(request.url).origin !== self.location.origin) return;

  // Explicitly skip script.google.com (Sheets sync is cross-origin no-cors POST, handled here to be safe)
  if (request.url.includes('script.google.com')) return;

  const url = new URL(request.url);
  const isNavigation = request.mode === 'navigate';
  const isHTML = request.destination === 'document' || url.pathname.endsWith('.html') || isNavigation;
  const isManifestOrIcon = url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.png');

  if (isHTML) {
    // Network-first for HTML (navigations and index.html)
    event.respondWith(
      fetch(request)
        .then(response => {
          // Only cache successful responses
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE).then(cache => {
              cache.put(request, responseToCache);
            }).catch(err => console.warn('Cache update failed:', err));
          }
          return response;
        })
        .catch(err => {
          console.warn('Network fetch failed, trying cache:', err);
          return caches.match(request)
            .then(cached => cached || caches.match('./index.html'))
            .catch(cacheErr => {
              console.warn('Cache fallback failed:', cacheErr);
              return new Response('Offline', { status: 503 });
            });
        })
    );
  } else if (isManifestOrIcon) {
    // Cache-first for manifest and icons (these rarely change)
    event.respondWith(
      caches.match(request)
        .then(cached => cached || fetch(request)
          .then(response => {
            if (response && response.status === 200) {
              const responseToCache = response.clone();
              caches.open(CACHE).then(cache => {
                cache.put(request, responseToCache);
              }).catch(err => console.warn('Cache update failed:', err));
            }
            return response;
          })
          .catch(err => {
            console.warn('Network fetch failed for asset:', err);
            return new Response('Asset not found', { status: 404 });
          })
        )
        .catch(err => {
          console.warn('Cache lookup failed:', err);
          return new Response('Asset not found', { status: 404 });
        })
    );
  }
  // For other assets (CSS, JS, etc.), let them pass through by default
});
