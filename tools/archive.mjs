#!/usr/bin/env node
// Архів без компʼютера. GitHub Action (.github/workflows/archive.yml) раз на годину запускає цей скрипт:
//  • archive.json — усі публічні відео календаря й сезонів (режим doomsday, коли YouTube недоступний);
//    записи з локального скрипта (поля v, d тощо) не губляться — оновлюються лише назва, постер, опис;
//    відео, яке зникло з YouTube, з архіву НЕ видаляється (на те він і архів);
//  • posters/ID.jpg — постери на власному домені (не залежать від YouTube);
//  • d/РРРР-ММ-ДД/index.html — сторінка дня з прев'ю для Telegram/Instagram/Facebook (OG-теги),
//    людину одразу переносить на стіну днів (/#d=дата);
//  • sitemap.xml — головна й усі дні (для пошуковиків).
// Дата дня — за київським часом. Пише файли лише тоді, коли щось справді змінилось (без зайвих комітів).
//
// Змінні середовища:
//  YT_API_KEY           — серверний ключ YouTube Data API (секрет репозиторію). Без нього — ключ сайту з index.html
//                         з Referer сайту (він обмежений доменом).
//  ARCHIVE_OUT          — куди писати (типово — корінь репозиторію). Для тестів.
//  ARCHIVE_FIXTURE      — JSON {playlistId: [items]} замість запитів до YouTube. Для тестів.
//  ARCHIVE_NO_POSTERS=1 — не завантажувати постери (p = адреса YouTube).
//  ARCHIVE_SEASONS      — інший seasons.json замість того, що в корені (для тестів).
//
// Календар сховано (seasons.json → calendar.enabled: false): відео й далі архівуються (на будь-який формат сайту),
// але сторінок днів, днів у sitemap і постерів для «картки дня» не робимо. Увімкнули назад — наступний запуск
// сам згенерує все, чого бракує, з усього архіву.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.ARCHIVE_OUT || SRC);
const read = (f, def) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return def; } };
const SITE = 'https://' + (read(path.join(SRC, 'CNAME'), 'taras.kyiv.ua').trim() || 'taras.kyiv.ua');
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
let changed = [];

// ── Налаштування (терпимо до тих самих ручних помилок, що й сайт) ──
function loose(text) {
    try { return JSON.parse(text); } catch (e) { return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')); }
}
function playlistId(v) {
    let s = String(v || '').trim(), m;
    if ((m = s.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/))) return 'UU' + m[1].slice(2);   // канал → його завантаження
    if ((m = s.match(/[?&]list=([\w-]+)/))) return m[1];
    return /^[\w-]+$/.test(s) ? s : '';
}
function normDate(v) {
    let s = String(v || '').trim(), m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
}
const cfg = loose(read(process.env.ARCHIVE_SEASONS || path.join(SRC, 'seasons.json'), '{}').replace(/^\uFEFF/, ''));
const cal = cfg && !Array.isArray(cfg) && cfg.calendar ? cfg.calendar : null;
const calOn = !!cal && !/^(false|ні|no|0|off)$/i.test(String(cal.enabled ?? 'true').trim());   // сховано — без сторінок днів
const calPl = cal ? playlistId(cal.playlist) : '';
const calStart = cal ? normDate(cal.start) : '';
const exclude = cal ? [].concat(cal.exclude || []).map(playlistId).filter(Boolean) : [];
const seasonPls = (Array.isArray(cfg) ? cfg : (cfg.seasons || [])).map(s => s && playlistId(s.playlist)).filter(Boolean);

// ── YouTube ──
const siteKey = (read(path.join(SRC, 'index.html'), '').match(/const API_KEY = '([\w-]+)'/) || [])[1];
const KEY = process.env.YT_API_KEY || siteKey;
const HEADERS = process.env.YT_API_KEY ? {} : { Referer: SITE + '/' };
const FIELDS = 'nextPageToken,items(snippet(title,description,thumbnails,resourceId/videoId),contentDetails(videoId,videoPublishedAt),status/privacyStatus)';
const fixture = process.env.ARCHIVE_FIXTURE ? JSON.parse(read(process.env.ARCHIVE_FIXTURE, '{}')) : null;

async function playlistItems(pid) {
    if (fixture) return fixture[pid] || [];
    let items = [], token = '';
    do {
        let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails,status&maxResults=50` +
            `&playlistId=${encodeURIComponent(pid)}&fields=${encodeURIComponent(FIELDS)}&key=${KEY}${token ? '&pageToken=' + token : ''}`;
        let res = await fetch(url, { headers: HEADERS });
        let data = await res.json().catch(() => ({}));
        if (res.status === 404 && /^UU/.test(pid)) return [];        // на каналі ще нема публічних відео — не помилка
        if (!res.ok || data.error) throw new Error(`YouTube ${res.status} для ${pid}: ${(data.error && data.error.message) || ''}`);
        items.push(...(data.items || []));
        token = data.nextPageToken || '';
    } while (token);
    return items;
}

const kyivDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
function bestThumb(t = {}) {
    for (const k of ['maxres', 'standard', 'high', 'medium', 'default']) if (t[k] && t[k].url) return t[k];
    return null;
}
function publicVideos(items) {
    return items.filter(i => i.snippet && i.contentDetails && i.contentDetails.videoPublishedAt && (i.status || {}).privacyStatus !== 'private')
        .map(i => ({ y: i.contentDetails.videoId || i.snippet.resourceId.videoId, t: i.snippet.title || '', desc: i.snippet.description || '',
            ts: i.contentDetails.videoPublishedAt, date: kyivDay(i.contentDetails.videoPublishedAt), thumbs: i.snippet.thumbnails || {} }));
}

// ── Запис лише змін ──
function writeIfChanged(rel, content) {
    let f = path.join(OUT, rel);
    if (read(f, null) === content) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    changed.push(rel);
}

async function poster(v) {
    if (process.env.ARCHIVE_NO_POSTERS) return '';
    let rel = `posters/${v.y}.jpg`, f = path.join(OUT, rel);
    if (fs.existsSync(f)) return rel;
    if (fixture) return '';
    try {   // 480×360 — досить для клітинки календаря й легко для репозиторію (~30 КБ)
        let res = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(v.y)}/hqdefault.jpg`);
        if (!res.ok) return '';
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
        changed.push(rel);
        return rel;
    } catch (e) { return ''; }
}

// Кадр для «картки дня» (Stories, 1080 px завширшки): maxresdefault 1280×720, якщо нема — sddefault 640×480.
// Окремий файл posters/ID-hd.jpg (~100 КБ), лише поки календар на сайті.
async function posterHd(v) {
    if (process.env.ARCHIVE_NO_POSTERS || fixture || !calOn) return;
    let rel = `posters/${v.y}-hd.jpg`, f = path.join(OUT, rel);
    if (fs.existsSync(f)) return;
    for (const name of ['maxresdefault', 'sddefault']) {
        try {
            let res = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(v.y)}/${name}.jpg`);
            if (!res.ok) continue;
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
            changed.push(rel);
            return;
        } catch (e) {}
    }
}

// ── Сторінка дня: прев'ю для месенджерів + миттєвий перехід на стіну днів ──
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cleanNote(desc) {   // як на сайті: без маркера №, штампа 🕒 і хвоста з хештегів
    return String(desc || '').replace(/\r/g, '').replace(/№(?!\d)/g, '').replace(/🕒\s*\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4}/, '')
        .replace(/(\s+#[\p{L}\p{N}_]+)+\s*$/u, '').replace(/\s+/g, ' ').trim();
}
const showTitle = t => String(t || '').replace(/(\s+#[\p{L}\p{N}_]+)+\s*$/u, '').trim() || String(t || '');
function dayPage(date, items, thumbOf) {
    let [y, m, d] = date.split('-').map(Number), human = `${d} ${MONTHS_GEN[m - 1]} ${y}`;
    let first = items[0], title = showTitle(first.t) || 'Стрічка дня';
    let note = cleanNote(first.desc), excerpt = note.length > 200 ? note.slice(0, 197).replace(/\s+\S*$/, '') + '…' : note;
    let th = thumbOf(first), img = th ? th.url : (first.p ? (/^https?:/.test(first.p) ? first.p : `${SITE}/${first.p}`) : `${SITE}/icons/icon-512.png`);
    let url = `${SITE}/d/${date}/`, hash = `/#d=${date}`;
    let more = items.length > 1 ? ` (+${items.length - 1})` : '';
    return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(human)} — ${esc(title)}${more} · Тарас Максимʼяк</title>
<meta name="description" content="${esc(excerpt || 'Одне відео про день, який більше не повториться.')}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Тарас Максимʼяк">
<meta property="og:title" content="${esc(human)} — ${esc(title)}${more}">
<meta property="og:description" content="${esc(excerpt || 'Одне відео про день, який більше не повториться.')}">
<meta property="og:image" content="${esc(img)}">${th && th.width ? `
<meta property="og:image:width" content="${th.width}">
<meta property="og:image:height" content="${th.height}">` : ''}
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌓</text></svg>">
<script>location.replace(${JSON.stringify(hash)});</script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222}
img{width:100%;border-radius:8px}a{color:#e62117}.k{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#6f6f6f}</style>
</head>
<body>
<p class="k"><a href="/">Тарас Максимʼяк</a> · стіна днів</p>
<h1>${esc(human)}</h1>
${items.map(v => `<h2>${esc(showTitle(v.t))}</h2>
${v.y ? `<p><a href="https://www.youtube.com/watch?v=${esc(v.y)}">Дивитися на YouTube</a></p>` : ''}
${cleanNote(v.desc) ? `<p>${esc(cleanNote(v.desc))}</p>` : ''}`).join('\n')}
<p><a href="${hash}">Відкрити на стіні днів →</a></p>
</body>
</html>
`;
}

// ── Головне ──
const pls = [...new Set([calPl, ...exclude, ...seasonPls].filter(Boolean))];
const byPl = {};
for (const pid of pls) byPl[pid] = publicVideos(await playlistItems(pid));
const skip = new Set(exclude.flatMap(pid => byPl[pid].map(v => v.y)));
const vids = new Map();
(byPl[calPl] || []).filter(v => !skip.has(v.y) && (!calStart || v.date >= calStart)).forEach(v => vids.set(v.y, v));
seasonPls.forEach(pid => byPl[pid].forEach(v => vids.set(v.y, v)));

const archive = loose(read(path.join(OUT, 'archive.json'), null) || read(path.join(SRC, 'archive.json'), '{}')) || {};
const days = JSON.parse(JSON.stringify(archive.days || {}));
const where = new Map();                                     // y → дата, під якою відео вже лежить в архіві
Object.entries(days).forEach(([date, list]) => (Array.isArray(list) ? list : []).forEach(it => { if (it && it.y) where.set(it.y, date); }));

for (const v of [...vids.values()].sort((a, b) => a.ts < b.ts ? -1 : 1)) {
    let p = await poster(v), fresh = { t: v.t, desc: v.desc };
    await posterHd(v);
    let date = where.get(v.y);
    if (date) {                                              // уже є — оновлюємо текст, локальні поля (v, d…) лишаються
        let list = days[date], i = list.findIndex(it => it.y === v.y), it = Object.assign({}, list[i], fresh);
        if (!it.p || /i\.ytimg\.com/.test(it.p) || (p && it.p !== p)) it.p = p || (bestThumb(v.thumbs) || {}).url || it.p || '';
        if (date !== v.date) { list.splice(i, 1); if (!list.length) delete days[date]; (days[v.date] = days[v.date] || []).push(it); }
        else list[i] = it;
    } else {
        (days[v.date] = days[v.date] || []).push(Object.assign({ t: v.t, p: p || (bestThumb(v.thumbs) || {}).url || '', y: v.y }, { desc: v.desc }));
    }
}
const sortedDays = Object.fromEntries(Object.keys(days).sort().map(d => [d, days[d]]));
// «2026-10-03T14:05:00+03:00» — київський час з поясом, як у локального скрипта
function kyivStamp(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(now).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '') || '+00:00'}`;
}
if (JSON.stringify(sortedDays) !== JSON.stringify(archive.days || {}))
    writeIfChanged('archive.json', JSON.stringify({ base: archive.base || '', days: sortedDays, generated: kyivStamp() }, null, 2) + '\n');

// Сторінки днів і sitemap (з усього архіву, не лише з того, що зараз на YouTube)
const thumbOf = it => { let v = vids.get(it.y); return v ? bestThumb(v.thumbs) : null; };
const dates = !calOn ? [] : Object.keys(sortedDays).filter(d => Array.isArray(sortedDays[d]) && sortedDays[d].some(it => it && (it.y || it.p)));
dates.forEach(d => writeIfChanged(`d/${d}/index.html`, dayPage(d, sortedDays[d].filter(it => it && (it.y || it.p)), thumbOf)));
writeIfChanged('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc></url>
${dates.map(d => `  <url><loc>${SITE}/d/${d}/</loc><lastmod>${d}</lastmod></url>`).join('\n')}${dates.length ? '\n' : ''}</urlset>
`);

console.log(`Відео з YouTube: ${vids.size}; днів в архіві: ${Object.keys(sortedDays).length}; змінено файлів: ${changed.length}`);
changed.slice(0, 50).forEach(f => console.log('  ' + f));
