/* Service worker — caches the app shell so Podcast Organiser opens instantly and installs on a phone.
 * Spotify API calls and artwork are never cached here (cross-origin requests are left alone).
 * When you change any app file, bump CACHE below so phones pick up the new version. */
const CACHE = 'po-shell-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'logic.js', 'spotify.js', 'data.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Spotify API, accounts and images: straight to the network

  event.respondWith((async () => {
    // ignoreSearch so the OAuth return address (…/?code=…&state=…) still gets the app shell
    const cached = await caches.match(req, { ignoreSearch: true });
    const network = fetch(req).then(res => {
      // never store URLs with a query string (the OAuth callback carries a one-time code)
      if (res.ok && url.search === '') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }   // stale-while-revalidate
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') { const shell = await caches.match('index.html'); if (shell) return shell; }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
