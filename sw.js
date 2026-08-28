// Minimal PWA service worker: caches the static shell for offline/installability.
// The live status fetch (status.openai.com) is cross-origin and intentionally
// bypassed here so the verdict is always fresh, never served from cache.
//
// ⚠ BUMP `CACHE` ON EVERY DEPLOY that changes code. The old v1 worker served
// script.js/config.js cache-first, so returning visitors kept running whatever
// build they first installed — a fixed bug would never reach them. Code and markup
// are now network-first (below); only images stay cache-first.
const CACHE = "iscodexup-shell-v8";
const SHELL = [
  "./",
  "./index.html",
  "./history.html",
  "./style.css",
  "./script.js",
  "./history.js",
  "./config.js",
  "./rails.js",
  "./theme.js",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/codex-status-up-online-green-transparent.webp",
  "./assets/codex-status-down-offline-red-transparent.webp",
  "./assets/codex-status-unknown-yellow-transparent.webp",
  "./assets/atlas/atlas-quest-gameplay.webp",
  "./assets/atlas-quest-mark.svg",
  "./assets/snackpack-arcade-mark.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first with a cached fallback: always try the network, fall back to the
// cache when offline, and refresh the cache on every success.
function networkFirst(req, fallback) {
  return fetch(req)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })
    .catch(() => caches.match(req).then((hit) => hit || (fallback ? caches.match(fallback) : undefined)));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Only handle same-origin GETs; let the status API and everything else pass through.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // Navigations: network-first, fall back to the cached page (then the shell) offline.
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, "./index.html"));
    return;
  }

  // Code and markup must never go stale — a status site that ships a fix needs it
  // to actually land. Network-first, cache only as the offline fallback.
  const url = new URL(req.url);
  if (/\.(?:js|css|html|webmanifest)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req));
    return;
  }

  // Images and everything else: cache-first, then network (and cache the result).
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
    )
  );
});
