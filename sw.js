/* ProfitTrack service worker - offline app shell caching */
const CACHE = 'profittrack-v23';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png','./update-banner.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// allow the page to trigger immediate activation of an updated worker
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // App shell AND icons: network-first so code and icon changes show immediately.
  const isShellOrIcon = url.origin === location.origin &&
    (/\.(html|css|js|png|json)$|\/$/.test(url.pathname));

  if (isShellOrIcon) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return resp;
      }).catch(() => caches.match(event.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for anything else
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
