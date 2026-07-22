const CACHE_NAME = 'travel42uy';
const VERSION = 'v17';
const CACHE = `${CACHE_NAME}-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './app.js',
  './map.js',
  './cities.js',
  './commands.js',
  './history.js',
  './store.js',
  './db.js',
  './confirm.js',
  './drive.js',
  './share.js',
  './sync.js',
  './icon.svg',
  './fonts/fonts.css',
  './fonts/alegreya-800.woff2',
  './fonts/alegreya-sans-400.woff2',
  './fonts/alegreya-sans-700.woff2',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './splash/splash-1290x2796.png',
  './splash/splash-1284x2778.png',
  './splash/splash-1179x2556.png',
  './splash/splash-1170x2532.png',
  './splash/splash-1242x2688.png',
  './splash/splash-1242x2208.png',
  './splash/splash-1125x2436.png',
  './splash/splash-828x1792.png',
  './splash/splash-750x1334.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache:'reload' bypasses the HTTP cache — without it, version bumps
      // inside the CDN max-age window precache fossilised files.
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const oldKeys = keys.filter((k) => k.startsWith(CACHE_NAME + '-') && k !== CACHE);
    const wasUpdate = oldKeys.length > 0;
    await Promise.all(oldKeys.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (wasUpdate) {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.postMessage({ type: 'RELOAD' }));
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Cross-origin (tiles OSM, fotos externas) va directo a la red.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
