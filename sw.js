// App shell cache so the screen opens without signal. Map tiles and TomTom calls always go to the network.
const CACHE_VERSION = "v202611241223";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./geo.js", "./cameras.json", "./vendor/maplibre-gl.js", "./vendor/maplibre-gl.css", "./icon-180.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  // network first, so a new deploy shows up on the next open; cache only as the no-signal fallback
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
