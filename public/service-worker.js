const CACHE_NAME = "inventory-cache-v1";

const urlsToCache = [
  "/",
  "/login.html",
  "/index.html",
  "/invoice.html",
  "/reset.html"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});