// ============================================================================
// SERVICE WORKER
// ============================================================================
// This is what lets the app be installed on a phone home screen and still open
// when there is no signal.
//
// Strategy: always try the network first, fall back to a cached copy. That way
// you always get the current version when online, and the shell still opens
// when you are not. Saving a thought needs the network — offline you can still
// open the app and read what is cached.
// ============================================================================

const CACHE = 'open-brain-v1';
const SHELL = ['./', './index.html', './config.js', './manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {})          // a missing file must not block installation
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;

  // Never cache API traffic — saving and searching must always hit the network,
  // and a stale cached answer would be worse than an honest failure.
  if (request.method !== 'GET' || request.url.includes('/functions/v1/')
      || request.url.includes('/rest/v1/') || request.url.includes('/auth/v1/')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(res => {
        // Keep a fresh copy of anything we successfully fetched
        if (res.ok && request.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html')))
  );
});
