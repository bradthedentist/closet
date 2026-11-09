// Service worker: caches the APP SHELL ONLY (same-origin code, styles, fonts, icons). It never touches Google API
// traffic, photos, or the model files (those use the app's own SHA-verified Cache API cache; public files only).
const VERSION = 'closet-shell-v1.0.1';
const SHELL = ['./', 'index.html', 'oauth.html', 'manifest.webmanifest', 'config.js', 'css/app.css',
  'js/app.js', 'js/ui.js', 'js/board.js', 'js/touchup.js', 'js/oauth-return.js',
  'js/core/policy.js', 'js/core/catalog.js', 'js/core/hash.js', 'js/core/drive.js', 'js/core/store.js', 'js/core/import-queue.js', 'js/core/auth.js', 'js/core/idb.js', 'js/core/mock-drive.js', 'js/core/geom.js',
  'js/ml/ort.js', 'js/ml/classifier.js', 'js/ml/cutout.js', 'js/ml/photo-prep.js',
  'fonts/DMSans-Variable.ttf', 'fonts/InstrumentSerif-Regular.ttf', 'fonts/InstrumentSerif-Italic.ttf',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/favicon-32.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('closet-shell-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null;
  if (rel === null || rel.startsWith('models/')) return;
  const isNav = req.mode === 'navigate';
  const key = isNav ? (rel === 'oauth.html' ? 'oauth.html' : 'index.html') : (rel === '' ? './' : rel);
  if (!isNav && !SHELL.includes(key)) return;
  // Network first so updates arrive; cached shell when offline.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok && !isNav) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); } return res; })
    .catch(() => caches.open(VERSION).then((c) => c.match(key).then((r) => r || c.match('index.html')))));
});
