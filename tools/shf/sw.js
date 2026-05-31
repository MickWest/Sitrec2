// sw.js — service worker for the standalone Starlink Flare Predictor PWA.
//
// Strategy (runtime caching, no hand-maintained precache list):
//   - navigations: network-first so a new build shows immediately when online,
//     falling back to the cached app shell when offline;
//   - same-origin assets: cache-first — they are version-stamped (`?v=<build>`),
//     so a new build means new URLs (cache misses) that fetch fresh, while within
//     a build everything is served instantly and works offline after one visit;
//   - cross-origin requests (geocoding, TLE fetch) are never cached — they pass
//     straight to the network and the app degrades gracefully when offline
//     (synthetic constellation is the default).
//
// __BUILD_V__ is stamped at build time (see webpackCopyPatterns.js). It changes
// every build, so the browser sees a byte-different sw.js, installs the new worker,
// and `activate` deletes the previous build's cache.
const VERSION = "__BUILD_V__";
const CACHE = "starlink-flares-" + VERSION;

self.addEventListener("install", () => {
  self.skipWaiting();                       // activate the new worker as soon as it's parsed
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith("starlink-flares-") && n !== CACHE).map((n) => caches.delete(n))
    );
    await self.clients.claim();             // control already-open pages
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                              // only GETs are cacheable
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // never cache cross-origin (geocoding/TLE)

  // Navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const resp = await fetch(req);
        cache.put(req, resp.clone());
        return resp;
      } catch (_) {
        return (await cache.match(req, { ignoreSearch: true }))
          || (await cache.match("index.html"))
          || (await cache.match("./"))
          || Response.error();
      }
    })());
    return;
  }

  // Same-origin assets: cache-first (versioned URLs make this safe and fast).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const resp = await fetch(req);
    if (resp && resp.status === 200 && resp.type === "basic") cache.put(req, resp.clone());
    return resp;
  })());
});
