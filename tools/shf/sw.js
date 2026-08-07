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
// The SW's own scope path (the directory it was registered from), e.g. "/sitrec/tools/shf/".
// Only assets UNDER this path are runtime-cached; other same-origin URLs (notably the Sitrec
// TLE proxy at /sitrecServer/proxy.php) must bypass the cache. Derived from self.location so it
// matches whatever case the tool was opened with (e.g. /tools/SHF/ on a case-insensitive FS).
const SCOPE = new URL("./", self.location).pathname;
// Shared tool libraries live one level up, OUTSIDE this SW's scope — currently
// DeviceOrientationCompass.js, which the results compass imports on first use. The
// worker still SEES those requests (scope limits which pages it controls, not which
// fetches it observes), so cache them alongside the tool's own assets; without this
// the rose's live compass would be the one thing that stopped working offline.
const SHARED = new URL("../src/", self.location).pathname;

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

  // Only runtime-cache the tool's OWN assets (under the SW scope, all version-stamped or
  // static). Other same-origin requests — above all the Sitrec TLE proxy
  // (/sitrecServer/proxy.php?request=CURRENT_STARLINK) — pass straight to the network so a
  // {cache:"no-store"} fetch reaches the server instead of being served stale from Cache Storage.
  if (!url.pathname.startsWith(SCOPE) && !url.pathname.startsWith(SHARED)) return;

  // Same-origin tool assets: cache-first (versioned URLs make this safe and fast).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const resp = await fetch(req);
    if (resp && resp.status === 200 && resp.type === "basic") cache.put(req, resp.clone());
    return resp;
  })());
});
