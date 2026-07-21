/* ─────────────────────────────────────────────────────────────
   BUMP THIS STRING EVERY TIME YOU CHANGE index.html.
   Nothing else in the deploy matters as much as this line.
   ───────────────────────────────────────────────────────────── */
const VERSION = 'lpb-2026-07-18a';

const FONTS = VERSION + '-fonts';
const SHELL = [
  './', './index.html', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Google Fonts: stale-while-revalidate so a dead zone doesn't strip the typography
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell: cache-first, which is why VERSION above must change on every deploy
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).catch(() => caches.match('./index.html')))
  );
});
