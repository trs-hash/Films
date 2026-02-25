const CACHE_NAME = 'kinoarchive-v1';
const urlsToCache = [
  './',
  './index.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  // Використовуємо стратегію "Stale-while-revalidate" для швидкого завантаження
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        caches.open(CACHE_NAME).then(cache => {
          if (event.request.method === 'GET' && !event.request.url.includes('googleapis')) {
            cache.put(event.request, networkResponse.clone());
          }
        });
        return networkResponse;
      });
      return cachedResponse || fetchPromise;
    })
  );
});
