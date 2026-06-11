// Minimal PWA service worker: caches the static shell for offline/installability.
// The live status fetch (status.openai.com) is cross-origin and intentionally
// bypassed here so the verdict is always fresh, never served from cache.
const CACHE = "iscodexup-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./config.js",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/codex-status-up-online-green-transparent.webp",
  "./assets/codex-status-down-offline-red-transparent.webp",
  "./assets/codex-status-unknown-yellow-transparent.webp",
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

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Only handle same-origin GETs; let the status API and everything else pass through.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  // Static assets: cache-first, then network (and cache the result).
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
    )
  );
});
