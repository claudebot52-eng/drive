// App shell cache so the screen opens without signal. Map tiles and TomTom calls always go to the network.
const CACHE_VERSION = "v202611241518";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./geo.js", "./colors.js", "./cameras.json", "./vendor/maplibre-gl.js", "./vendor/maplibre-gl.css", "./icon-180.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  // Network first and never the browser's own HTTP cache (GitHub Pages allows 10 minutes of staleness),
  // so a new deploy shows on the next open. The stored copy is only the no-signal fallback.
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { const copy = r.clone(); caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
