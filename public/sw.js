/**
 * LiveWave service worker (registered in production builds only).
 *
 * Strategy:
 *  - App shell (navigations): network-first with cached fallback — the app
 *    loads even when the network blips, and works offline after one visit.
 *  - /api/* data: network-first with cached copy — fresh data normally, last
 *    known playlist/metadata when offline (browsing works; streams won't).
 *  - Static assets (js/css/icons/manifest): cache-first with background refresh.
 *  - Everything cross-origin (streams, channel logos) passes through untouched,
 *    so hls.js and <img> behave exactly as if there were no worker.
 *
 * Bump the CACHE version when you change caching behavior.
 */
const CACHE = 'livewave-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request: req } = e;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // streams + logos: pass through

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/'));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(cacheFirstWithRefresh(req));
});

/** Fresh data normally; fall back to the last cached copy on failure. */
function networkFirst(req, fallbackUrl) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() =>
      caches.match(req).then((hit) => hit || (fallbackUrl ? caches.match(fallbackUrl) : undefined)),
    );
}

/** Serve the cached copy instantly, refresh it in the background. */
function cacheFirstWithRefresh(req) {
  const network = fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  return caches.match(req).then((hit) => hit || network);
}
