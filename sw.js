// Сервіс-воркер «Лови день» (PWA): сайт відкривається й без інтернету.
//  • Файли сайту (сторінка, seasons.json, archive.json, постери, сторінки днів) — спершу мережа, тож завжди свіже;
//    без мережі — остання збережена копія. Дані про відео сторінка й так тримає в localStorage.
//  • Шрифти й іконки не змінюються (нова версія — нова назва файлу) — одразу з кешу, без запиту в мережу:
//    повторний візит на повільному інтернеті не чекає на них.
//  • Чуже (YouTube API, мініатюри i.ytimg.com, плеєр) не чіпаємо: кешувати «непрозорі» відповіді з інших доменів
//    дорого для сховища браузера.
// Попередній sw.js (kinoarchive-v1) ніде не реєструвався; його кеш, якщо раптом є, видаляємо.
const CACHE = 'site-v1';
const SHELL = ['./', 'seasons.json', 'state.json', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
    const req = e.request, url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== location.origin) return;
    e.respondWith(/^\/(fonts|icons)\//.test(url.pathname) ? cacheFirst(req, url) : networkFirst(req, url));
});

async function cacheFirst(req, url) {
    const cache = await caches.open(CACHE), key = url.origin + url.pathname;
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
}

async function networkFirst(req, url) {
    const cache = await caches.open(CACHE);
    const key = url.origin + url.pathname;                    // ?cb= (режим ?check) не плодить копій
    try {
        const res = await fetch(req);
        if (res.ok) cache.put(key, res.clone());
        return res;
    } catch (err) {
        const hit = await cache.match(key) || (req.mode === 'navigate' ? await cache.match(url.origin + '/') : null);
        return hit || Response.error();
    }
}
