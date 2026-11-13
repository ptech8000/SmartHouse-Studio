const CACHE_NAME = 'smarthouse-studio-v1';
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never serve stale /api responses from cache
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests: network first, fallback to cached shell for offline resilience
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/', clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: cache hit with background revalidation
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
